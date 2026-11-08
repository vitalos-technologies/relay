// In-process simulation of the AT Protocol XRPC endpoints the Bluesky adapter/connector use. Serves ONLY
// simulated (mock_) destinations and tests. Scenarios: success · processing (Bluesky has no asynchronous media
// processing: behaves like success) · fail_permanent (createRecord InvalidRequest) · fail_transient_once ·
// rate_limited_once (429 RateLimitExceeded + ratelimit-reset) · timeout_after_send (record stored, response lost)
// · revoked (app password revoked: AuthenticationRequired / ExpiredToken) · missing_permission (AccountDeactivated).
import { createHash } from 'node:crypto';
import { TransportError, graphemeLength, type HttpRequest, type HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type FakeHandler } from '../transport/mock.js';
import { parseJson } from '../shared/http.js';
import { TID_RE } from './api.js';

const xErr = (status: number, error: string, message: string, headers: Record<string, string> = {}) => json(status, { error, message }, headers);
const once = async (env: FakeEnv, key: string) => (await env.store.incr(`bluesky:${env.accountId}:${env.scenario}:${key}`)) === 1;
const jwt = (exp: number) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ scope: 'com.atproto.appPass', exp })).toString('base64url')}.mock`;
export const FAKE_PDS = 'https://morel.us-east.host.bsky.network';

export const blueskyFake: FakeHandler = async (req: HttpRequest, env: FakeEnv): Promise<HttpResponse> => {
  const url = new URL(req.url);
  const nsid = url.pathname.replace(/^\/xrpc\//, '');
  const body = typeof req.body === 'string' ? parseJson(req.body) : {};
  const did = env.accountId.startsWith('did:') ? env.accountId : `did:plc:${env.accountId}`;
  const session = () => {
    const exp = Math.floor(env.now().getTime() / 1000) + 7200;
    return { did: env.accountId, handle: 'sim.bsky.social', accessJwt: jwt(exp), refreshJwt: jwt(exp + 86400 * 60), active: true,
      didDoc: { id: did, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: FAKE_PDS }] } };
  };

  if (nsid === 'com.atproto.server.createSession') {
    if (!body.identifier || !body.password) return xErr(400, 'InvalidRequest', 'identifier and password are required');
    if (env.scenario === 'revoked') return xErr(401, 'AuthenticationRequired', 'Invalid identifier or password');
    return json(200, session());
  }
  if (nsid === 'com.atproto.server.refreshSession') {
    if (env.scenario === 'revoked') return xErr(400, 'ExpiredToken', 'Token has been revoked');
    return /^Bearer ey/.test(req.headers?.authorization ?? '') ? json(200, session()) : xErr(401, 'AuthenticationRequired', 'refresh token required');
  }
  if (nsid === 'app.bsky.feed.getPosts') {
    const uri = url.searchParams.get('uris') ?? '';
    const obj = await env.store.get('bluesky', `mock_${uri.split('/').pop() ?? ''}`);
    return json(200, { posts: obj ? [{ uri, cid: obj.data.cid, likeCount: 12, repostCount: 3, replyCount: 2, quoteCount: 1, bookmarkCount: 4, indexedAt: obj.createdAt }] : [] });
  }
  if (!/^Bearer /.test(req.headers?.authorization ?? '')) return xErr(401, 'AuthenticationRequired', 'Authentication Required');
  if (env.scenario === 'revoked') return xErr(400, 'ExpiredToken', 'Token has expired');

  switch (nsid) {
    case 'com.atproto.server.getSession':
      return json(200, { did: env.accountId, handle: 'sim.bsky.social', active: env.scenario !== 'missing_permission', ...(env.scenario === 'missing_permission' ? { status: 'deactivated' } : {}) });
    case 'com.atproto.identity.resolveHandle': {
      const h = url.searchParams.get('handle') ?? '';
      return h.endsWith('.invalid') ? xErr(400, 'InvalidRequest', 'Unable to resolve handle') : json(200, { did: `did:plc:${createHash('sha256').update(h).digest('hex').slice(0, 24)}` });
    }
    case 'com.atproto.repo.uploadBlob': {
      if (!(req.body instanceof Uint8Array)) return xErr(400, 'InvalidRequest', 'raw bytes required');
      if (req.body.byteLength > 2_000_000) return xErr(400, 'BlobTooLarge', 'This file is too large');
      const link = `bafkrei${createHash('sha256').update(req.body).digest('hex').slice(0, 40)}`;
      return json(200, { blob: { $type: 'blob', ref: { $link: link }, mimeType: req.headers?.['content-type'] ?? 'application/octet-stream', size: req.body.byteLength } });
    }
    case 'com.atproto.repo.createRecord': {
      const b = body as { repo?: string; collection?: string; rkey?: string; record?: { $type?: string; text?: string; createdAt?: string; embed?: { images?: Array<{ alt?: unknown }> } } };
      if (b.collection !== 'app.bsky.feed.post' || b.record?.$type !== 'app.bsky.feed.post' || typeof b.record.text !== 'string' || !b.record.createdAt) return xErr(400, 'InvalidRequest', 'Invalid app.bsky.feed.post record');
      if (b.rkey !== undefined && !TID_RE.test(b.rkey)) return xErr(400, 'InvalidRequest', 'Invalid record key');
      if (graphemeLength(b.record.text) > 300) return xErr(400, 'InvalidRequest', 'Record/text must not be longer than 300 graphemes');
      if (b.record.embed?.images?.some((i) => typeof i.alt !== 'string')) return xErr(400, 'InvalidRequest', 'Record/embed/images/0 must have the property "alt"');
      if (env.scenario === 'missing_permission') return xErr(400, 'AccountDeactivated', 'Account is deactivated');
      if (env.scenario === 'fail_permanent') return xErr(400, 'InvalidRequest', 'Invalid app.bsky.feed.post record: facets');
      if (env.scenario === 'fail_transient_once' && await once(env, 'create')) throw new TransportError('simulated: connection refused before sending', 'connect', false);
      if (env.scenario === 'rate_limited_once' && await once(env, 'create')) {
        return xErr(429, 'RateLimitExceeded', 'Rate Limit Exceeded', { 'ratelimit-limit': '5000', 'ratelimit-remaining': '0', 'ratelimit-reset': String(Math.floor(env.now().getTime() / 1000) + 30), 'ratelimit-policy': '5000;w=3600' });
      }
      const rkey = b.rkey ?? `mock${Date.now().toString(36)}`;
      const key = `mock_${rkey}`;
      if (await env.store.get('bluesky', key)) return xErr(400, 'InvalidRequest', 'Record already exists');
      const cid = `bafyrei${createHash('sha256').update(JSON.stringify(b.record)).digest('hex').slice(0, 40)}`;
      await env.store.put({ provider: 'bluesky', accountId: env.accountId, objectId: key, kind: 'post', createdAt: env.now().toISOString(), data: { rkey, cid, record: b.record } });
      if (env.scenario === 'timeout_after_send') lostResponse();
      return json(200, { uri: `at://${b.repo}/app.bsky.feed.post/${rkey}`, cid, validationStatus: 'valid' });
    }
    case 'com.atproto.repo.getRecord': {
      const rkey = url.searchParams.get('rkey') ?? '';
      const obj = await env.store.get('bluesky', `mock_${rkey}`);
      if (!obj) return xErr(400, 'RecordNotFound', `Could not locate record: at://${url.searchParams.get('repo')}/app.bsky.feed.post/${rkey}`);
      return json(200, { uri: `at://${url.searchParams.get('repo')}/app.bsky.feed.post/${rkey}`, cid: obj.data.cid, value: obj.data.record });
    }
    default:
      return xErr(501, 'MethodNotImplemented', `Method Not Implemented: ${nsid}`);
  }
};
