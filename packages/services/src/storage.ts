// Private S3-compatible object storage (ME-01, ME-04). The bucket is never public:
// browsers upload through short-lived presigned POST policies and read through
// short-lived signed GET URLs issued only by authorized API calls.
//
// Two clients: `s3()` talks to S3_ENDPOINT (server-side operations); `signer()` signs URLs with
// S3_PUBLIC_ENDPOINT (when set) so the host matches what browsers/providers can reach.
import { Readable } from 'node:stream';
import {
  CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand,
  PutBucketCorsCommand, PutObjectCommand, S3Client, type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createPresignedPost, type PresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from '@social-lite/core';
import { config } from './config.js';
import { log } from './log.js';

let internal: S3Client | undefined;
let publicSigner: S3Client | undefined;
let clientKey: string | undefined;

function clientConfigKey(): string {
  const c = config();
  return [c.S3_ENDPOINT, c.S3_PUBLIC_ENDPOINT, c.S3_REGION, c.S3_ACCESS_KEY_ID, c.S3_FORCE_PATH_STYLE].join('|');
}

function build(endpoint: string | undefined): S3Client {
  const c = config();
  if (!c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY) {
    throw new AppError('provider_not_configured', 'Object storage is not configured');
  }
  return new S3Client({
    endpoint,
    region: c.S3_REGION,
    forcePathStyle: c.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY },
    // Only compute/validate checksums when the operation requires it (S3-compatible stores vary).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function refreshClients(): void {
  const key = clientConfigKey();
  if (key !== clientKey) {
    internal?.destroy();
    publicSigner?.destroy();
    internal = undefined;
    publicSigner = undefined;
    clientKey = key;
  }
}

/** Server-side S3 client (S3_ENDPOINT). */
export function s3(): S3Client {
  refreshClients();
  if (!internal) internal = build(config().S3_ENDPOINT);
  return internal;
}

/** Client used only to sign URLs handed to browsers/providers (S3_PUBLIC_ENDPOINT ?? S3_ENDPOINT). */
export function signer(): S3Client {
  refreshClients();
  const c = config();
  if (!c.S3_PUBLIC_ENDPOINT || c.S3_PUBLIC_ENDPOINT === c.S3_ENDPOINT) return s3();
  if (!publicSigner) publicSigner = build(c.S3_PUBLIC_ENDPOINT);
  return publicSigner;
}

export function bucket(): string {
  return config().S3_BUCKET;
}

const ensured = new Set<string>();

/**
 * Make sure the (private) bucket exists. Creates it only outside production; production buckets
 * are provisioned by infrastructure with public access blocked. Memoised per process.
 */
export async function ensureBucket(name = bucket()): Promise<void> {
  if (ensured.has(name)) return;
  try {
    await s3().send(new HeadBucketCommand({ Bucket: name }));
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404 && (err as Error).name !== 'NotFound' && (err as Error).name !== 'NoSuchBucket') throw err;
    if (config().APP_ENV === 'production') {
      throw new AppError('provider_not_configured', `Storage bucket ${name} does not exist`);
    }
    try {
      await s3().send(new CreateBucketCommand({ Bucket: name }));
    } catch (e) {
      const n = (e as Error).name;
      if (n !== 'BucketAlreadyOwnedByYou' && n !== 'BucketAlreadyExists') throw e;
    }
    // Allow browser uploads/reads from the app origin (best effort; not all stores support CORS config).
    try {
      await s3().send(new PutBucketCorsCommand({
        Bucket: name,
        CORSConfiguration: { CORSRules: [{ AllowedOrigins: [new URL(config().APP_BASE_URL).origin], AllowedMethods: ['POST', 'GET', 'HEAD'], AllowedHeaders: ['*'], MaxAgeSeconds: 600 }] },
      }));
    } catch {
      log.debug('storage_cors_not_supported', { bucket: name });
    }
    log.info('storage_bucket_created', { bucket: name });
  }
  ensured.add(name);
}

export async function headBucket(name = bucket()): Promise<void> {
  await s3().send(new HeadBucketCommand({ Bucket: name }));
}

/** Presigned POST restricted to an exact key, content type and size range (ME-01). */
export async function presignUpload(p: { key: string; contentType: string; maxBytes: number; minBytes?: number; expiresSeconds?: number }): Promise<PresignedPost> {
  return createPresignedPost(signer(), {
    Bucket: bucket(),
    Key: p.key,
    Conditions: [
      ['content-length-range', p.minBytes ?? 1, p.maxBytes],
      ['eq', '$key', p.key],
      ['eq', '$Content-Type', p.contentType],
    ],
    Fields: { 'Content-Type': p.contentType },
    Expires: p.expiresSeconds ?? 600,
  });
}

export async function signedGetUrl(key: string, ttlSeconds: number, opts: { contentType?: string; filename?: string } = {}): Promise<string> {
  return getSignedUrl(signer(), new GetObjectCommand({
    Bucket: bucket(), Key: key,
    ResponseContentType: opts.contentType,
    ResponseContentDisposition: opts.filename ? `inline; filename="${opts.filename.replace(/[^\w.-]/g, '_')}"` : undefined,
  }), { expiresIn: ttlSeconds });
}

export async function headObject(key: string): Promise<HeadObjectCommandOutput | null> {
  try {
    return await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (err as Error).name === 'NotFound' || (err as Error).name === 'NoSuchKey') return null;
    throw err;
  }
}

export async function putObject(key: string, body: Uint8Array, contentType: string, metadata?: Record<string, string>): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType, ContentLength: body.byteLength, Metadata: metadata }));
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export class ObjectTooLargeError extends Error {
  constructor(readonly limit: number) { super(`object exceeds ${limit} bytes`); }
}

/** Download an object, aborting as soon as more than maxBytes have been received. */
export async function getObjectBytes(key: string, maxBytes: number): Promise<Buffer> {
  const ac = new AbortController();
  const out = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }), { abortSignal: ac.signal });
  if (out.ContentLength !== undefined && out.ContentLength > maxBytes) {
    ac.abort();
    throw new ObjectTooLargeError(maxBytes);
  }
  const body = out.Body;
  if (!body) return Buffer.alloc(0);
  const stream = body instanceof Readable ? body : Readable.fromWeb((body as unknown as { transformToWebStream(): import('node:stream/web').ReadableStream }).transformToWebStream());
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += b.length;
    if (total > maxBytes) {
      stream.destroy();
      ac.abort();
      throw new ObjectTooLargeError(maxBytes);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks, total);
}
