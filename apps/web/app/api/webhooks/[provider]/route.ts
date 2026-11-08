// Provider webhooks: authenticated on the raw body, persisted and deduplicated before acknowledging.
import { receiveWebhook, verifyMetaSubscription } from '@social-lite/services/webhooks';
import { publicRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute<{ provider: string }>(async ({ req, params }) => {
  if (params.provider !== 'meta') return new Response('Not found', { status: 404 });
  const r = await verifyMetaSubscription(req.nextUrl.searchParams);
  return new Response(String(r.body), { status: r.status, headers: { 'content-type': 'text/plain' } });
});
export const POST = publicRoute<{ provider: string }>(async ({ req, params }) => {
  const r = await receiveWebhook(params.provider, await req.text(), req.headers);
  return Response.json(r.body, { status: r.status });
});
