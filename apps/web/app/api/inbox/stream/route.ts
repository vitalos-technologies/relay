// GET /api/inbox/stream?after=<id> — Server-Sent Events for the inbox (stream B; same pattern as /api/collab/stream).
// Small, content-free events ({ id, conversation_id, kind, at }) for conversations on brands the caller can read; the
// client refetches through the normal authorized APIs. Every 15 s the session, membership and inbox.read are re-checked:
// revoked access ends the stream with `event: revoked` (acceptance test 12). Streams end after ~55 s (`event: end`)
// and the client reconnects from its last id. Polling fallback: /api/inbox/events.
import { authorizeCtx } from '@social-lite/services/tenancy';
import { SESSION_COOKIE, loadAccess, resolveSession, type Ctx } from '@social-lite/services';
import { inboxEvents } from '@social-lite/services/inbox/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LIFETIME_MS = 55_000;
const POLL_MS = 1_500;
const RECHECK_MS = 15_000;

export const GET = route(async ({ req, ctx }) => {
  const first = await inboxEvents(ctx, {});   // also enforces inbox.read now
  let cursor = Number(req.headers.get('last-event-id') ?? req.nextUrl.searchParams.get('after') ?? 0) || first.last_id;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const enc = new TextEncoder();
  let closed = false;
  req.signal.addEventListener('abort', () => { closed = true; });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => { if (!closed) controller.enqueue(enc.encode(s)); };
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let live: Ctx = ctx;
      const began = Date.now();
      let checked = Date.now();
      let pinged = Date.now();
      send(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ cursor })}\n\n`);
      try {
        while (!closed && Date.now() - began < LIFETIME_MS) {
          if (Date.now() - checked > RECHECK_MS) {
            checked = Date.now();
            const s = await resolveSession(token);
            const access = s && s.session.activeWorkspaceId === ctx.access.workspaceId
              ? await loadAccess(s.actor.userId, ctx.access.workspaceId, undefined, { mfaVerified: s.session.mfaVerified, authTime: s.session.authTime?.toISOString() ?? null })
              : null;
            live = access ? { ...ctx, access } : ctx;
            if (!access || !authorizeCtx(live, 'inbox.read').allowed) { send(`event: revoked\ndata: {}\n\n`); break; }
          }
          const r = await inboxEvents(live, { after: cursor });
          for (const e of r.items) send(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
          cursor = r.last_id;
          if (r.items.length >= 200) continue;
          if (Date.now() - pinged > 15_000) { send(`: ping\n\n`); pinged = Date.now(); }
          await sleep(POLL_MS);
        }
        send(`event: end\ndata: ${JSON.stringify({ cursor })}\n\n`);
      } catch {
        send(`event: revoked\ndata: {}\n\n`);
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
