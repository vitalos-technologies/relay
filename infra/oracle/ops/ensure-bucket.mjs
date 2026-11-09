// Creates the private media bucket and its CORS rule (browser presigned POST from APP_BASE_URL) if missing.
// Production Relay never creates buckets itself (storage.ts), so the release job does it once. Idempotent.
// Env: S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, APP_BASE_URL. Prints no secrets.
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';

const env = process.env;
const bucket = env.S3_BUCKET || 'social-lite-media';
const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION || 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '' },
});

let created = false;
for (let attempt = 1; ; attempt++) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    break;
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchBucket') {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        created = true;
      } catch (e) {
        if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(e?.name)) throw e;
      }
      break;
    }
    if (attempt >= 30) throw err; // storage still starting
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const origin = new URL(env.APP_BASE_URL).origin;
try {
  await s3.send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: { CORSRules: [{ AllowedOrigins: [origin], AllowedMethods: ['POST', 'GET', 'HEAD'], AllowedHeaders: ['*'], MaxAgeSeconds: 600 }] },
  }));
  console.log(JSON.stringify({ msg: 'storage bucket ready', bucket, created, cors_origin: origin }));
} catch (e) {
  // SeaweedFS may not implement bucket CORS; the server-level -s3.allowedOrigins flag in compose.prod.yaml covers it.
  console.log(JSON.stringify({ msg: 'storage bucket ready', bucket, created, cors: 'server-level (bucket CORS not supported)', code: e?.name }));
}
