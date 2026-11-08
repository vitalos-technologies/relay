// Simulated YouTube comment endpoints for SIMULATED (mock_) channels — V3.5 stream B. Reached through the inbox mock
// transport (inbox-registry.ts) before the publishing fake. Comments live in the durable mock store.
import type { HttpRequest, HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type MockObject } from '../transport/mock.js';
import { parseJson } from '../shared/http.js';

const gErr = (status: number, reason: string, message: string) => json(status, { error: { code: status, message, errors: [{ reason, domain: 'youtube', message }] } });
const once = async (env: FakeEnv, k: string) => (await env.store.incr(`yt-inbox:${env.accountId}:${k}:${env.scenario}`)) === 1;

function toComment(o: MockObject) {
  const d = o.data as { parent_id: string | null; video_id: string; author: string; author_channel: string; text: string; at: string; updated?: string; status?: string };
  return { id: o.objectId, snippet: { ...(d.parent_id ? { parentId: d.parent_id } : {}), videoId: d.video_id, authorDisplayName: d.author, authorChannelId: { value: d.author_channel }, textOriginal: d.text, textDisplay: d.text, publishedAt: d.at, updatedAt: d.updated ?? d.at, moderationStatus: d.status ?? 'published' } };
}

export async function youtubeInboxFake(req: HttpRequest, env: FakeEnv): Promise<HttpResponse | null> {
  const u = new URL(req.url);
  if (u.hostname !== 'www.googleapis.com' || !u.pathname.startsWith('/youtube/v3/comment')) return null;
  if (env.scenario === 'revoked') return gErr(401, 'authError', 'Invalid Credentials');
  const all = () => env.store.list('youtube', env.accountId, 'yt_comment');
  if (u.pathname === '/youtube/v3/commentThreads' && req.method === 'GET') {
    if (u.searchParams.get('allThreadsRelatedToChannelId') !== env.accountId) return gErr(403, 'forbidden', 'The comment thread could not be retrieved.');
    const rows = (await all()).filter((o) => o.data.status !== 'deleted');
    const tops = rows.filter((o) => !o.data.parent_id).sort((a, b) => String(b.data.at).localeCompare(String(a.data.at)));
    return json(200, { items: tops.slice(0, 50).map((t) => ({ id: t.objectId, snippet: { videoId: t.data.video_id, topLevelComment: toComment(t), totalReplyCount: rows.filter((r) => r.data.parent_id === t.objectId).length }, replies: { comments: rows.filter((r) => r.data.parent_id === t.objectId).map(toComment) } })) });
  }
  if (u.pathname === '/youtube/v3/comments' && req.method === 'GET') {
    const parent = u.searchParams.get('parentId');
    return json(200, { items: (await all()).filter((o) => o.data.parent_id === parent && o.data.status !== 'deleted').map(toComment) });
  }
  if (env.scenario === 'missing_permission' && req.method !== 'GET') return gErr(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.');
  if (u.pathname === '/youtube/v3/comments' && req.method === 'POST') {
    const b = parseJson(typeof req.body === 'string' ? req.body : '') as { snippet?: { parentId?: string; textOriginal?: string } };
    const parent = b.snippet?.parentId ? await env.store.get('youtube', b.snippet.parentId) : null;
    if (!parent || parent.kind !== 'yt_comment' || parent.accountId !== env.accountId) return gErr(404, 'parentCommentNotFound', 'The parent comment could not be found.');
    if (!b.snippet?.textOriginal) return gErr(400, 'commentTextRequired', 'The comment text is required.');
    if (env.scenario === 'fail_permanent') return gErr(400, 'processingFailure', 'The API server failed to successfully process the request.');
    if (env.scenario === 'rate_limited_once' && await once(env, 'rate')) return gErr(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.');
    if (env.scenario === 'fail_transient_once' && await once(env, 'transient')) return gErr(503, 'backendError', 'Backend Error');
    const id = env.newId('mock_ytc_');
    const at = env.now().toISOString();
    const o: MockObject = { provider: 'youtube', accountId: env.accountId, objectId: id, kind: 'yt_comment', createdAt: at, data: { parent_id: parent.objectId, video_id: parent.data.video_id, author: 'Simulated channel', author_channel: env.accountId, text: b.snippet.textOriginal, at } };
    await env.store.put(o);
    if (env.scenario === 'timeout_after_send' && await once(env, 'timeout')) lostResponse();
    return json(200, toComment(o));
  }
  const target = u.searchParams.get('id') ? await env.store.get('youtube', u.searchParams.get('id')!) : null;
  if (!target || target.kind !== 'yt_comment' || target.accountId !== env.accountId) return gErr(404, 'commentNotFound', 'The comment could not be found.');
  if (u.pathname === '/youtube/v3/comments' && req.method === 'DELETE') {
    if (target.data.author_channel !== env.accountId) return gErr(403, 'forbidden', 'Only the comment author can delete it.');
    await env.store.put({ ...target, data: { ...target.data, status: 'deleted' } });
    return { status: 204, headers: {}, body: '' };
  }
  if (u.pathname === '/youtube/v3/comments/setModerationStatus' && req.method === 'POST') {
    const st = u.searchParams.get('moderationStatus');
    if (!['heldForReview', 'published', 'rejected'].includes(st ?? '')) return gErr(400, 'invalidModerationStatus', 'Invalid moderation status.');
    await env.store.put({ ...target, data: { ...target.data, status: st } });
    return { status: 204, headers: {}, body: '' };
  }
  return null;
}

/** Record a simulated viewer comment (top-level, or a reply under `parentId`). */
export async function recordSimulatedYouTubeComment(env: Pick<FakeEnv, 'store'>, channelId: string, c: { id: string; parentId: string | null; videoId: string; author: string; text: string; at: string }): Promise<void> {
  if (!channelId.startsWith('mock_')) throw new Error('simulated comments are only for mock_ channels');
  await env.store.put({ provider: 'youtube', accountId: channelId, objectId: c.id, kind: 'yt_comment', createdAt: c.at, data: { parent_id: c.parentId, video_id: c.videoId, author: c.author, author_channel: `mock_viewer_${c.author.replace(/\W/g, '').slice(0, 20) || 'x'}`, text: c.text, at: c.at } });
}
