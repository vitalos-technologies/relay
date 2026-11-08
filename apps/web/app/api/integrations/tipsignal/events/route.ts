// Signed TipSignal events → drafts (never posts). HMAC over `${t}.${rawBody}`, ±5 min window, dedupe on event_id.
import { receiveTipsignal } from '@social-lite/services/tipsignal';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = publicRoute(async ({ req }) => {
  const r = await receiveTipsignal(await req.text(), req.headers.get('x-tipsignal-signature'));
  return Response.json(r.body, { status: r.status });
});
