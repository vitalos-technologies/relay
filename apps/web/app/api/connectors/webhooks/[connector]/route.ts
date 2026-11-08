// POST /api/connectors/webhooks/:connector[?i=<installation id>] — business-connector webhooks. Verified on the RAW body
// (Slack/HubSpot signed timestamps, Asana hook secret, monday JWT, Mailchimp URL key, WhatsApp X-Hub-Signature-256),
// persisted + deduplicated, then acknowledged. Unverified requests are never stored; missing secrets answer 412.
import { ingestIntegrationWebhook } from '@social-lite/services/connectors/index';
import { publicRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = publicRoute<{ connector: string }>(async ({ req, params }) => {
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const r = await ingestIntegrationWebhook(params.connector, { rawBody: await req.text(), headers, method: req.method, uri: `${req.nextUrl.origin}${req.nextUrl.pathname}${req.nextUrl.search}` }, req.nextUrl.searchParams);
  return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
});
