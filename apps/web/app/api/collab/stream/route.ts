// GET /api/collab/stream?post=<id>&after=<cursor> — Server-Sent Events for one post's collaboration changes plus the
// caller's own notification events. Small, content-free events ({ id, kind, ref_id }); the client refetches through the
// normal authorized APIs. Every 15 s the session and access are re-checked: revoked membership, a signed-out session or
// lost access to the post ends the stream with `event: revoked`. Streams end after ~55 s (`event: end`) and the client
// reconnects from its last event id, so proxies never hold connections forever. Polling fallback: /api/collab/events.
import { AppError } from '@social-lite/core';
import { SESSION_COOKIE, loadAccess, postAudiences, readCollabEvents, resolveSession, type Ctx } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LIFETIME_MS = 55_000;
const POLL_MS = 1_500;
const RECHECK_MS = 15_000;

export const GET = route(async ({ req, ctx }) => {
  const postId = req.nextUrl.searchParams.get('post');
  const start = Number(req.headers.get('last-event-id') ?? req.nextUrl.searchParams.get('after') ?? 0) || 0;
  let scope = postId ? await postAudiences(ctx, postId) : null;
  if (postId && !scope) throw new AppError('not_found', 'Post not found');
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const enc = new TextEncoder();
  let closed = false;
  req.signal.addEventListener('abort', () => { closed = true; });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => { if (!closed) controller.enqueue(enc.encode(s)); };
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let cursor = start;
      let live: Ctx = ctx;
      const began = Date.now();
      let checked = Date.now();
      let pinged = Date.now();
      send(`retry: 3000\n: connected\n\n`);
      try {
        while (!closed && Date.now() - began < LIFETIME_MS) {
          if (Date.now() - checked > RECHECK_MS) {
            checked = Date.now();
            const s = await resolveSession(token);
            const access = s && s.session.activeWorkspaceId === ctx.access.workspaceId
              ? await loadAccess(s.actor.userId, ctx.access.workspaceId, undefined, { mfaVerified: s.session.mfaVerified, authTime: s.session.authTime?.toISOString() ?? null })
              : null;
            if (!access) { send(`event: revoked\ndata: {}\n\n`); break; }
            live = { ...ctx, access };
            if (postId) { scope = await postAudiences(live, postId); if (!scope) { send(`event: revoked\ndata: {}\n\n`); break; } }
          }
          const r = await readCollabEvents(live, { postId, after: cursor }, undefined, scope);
          if (r.reset) { send(`event: reset\ndata: ${JSON.stringify({ cursor: r.cursor })}\n\n`); cursor = r.cursor; continue; }
          for (const e of r.events) send(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
          cursor = r.cursor;
          if (r.more) continue;
          if (Date.now() - pinged > 15_000) { send(`: ping\n\n`); pinged = Date.now(); }
          await sleep(POLL_MS);
        }
        send(`event: end\ndata: ${JSON.stringify({ cursor })}\n\n`);
      } catch {
        send(`event: error\ndata: {}\n\n`);
      } finally {
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() { closed = true; },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  });
});
