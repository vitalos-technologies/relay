// POST /api/webhooks/notion — verified (X-Notion-Signature over the raw body), deduplicated; signal only.
import { handleNotionWebhook } from '@social-lite/services/content-hub/index';
import { publicRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = publicRoute(async ({ req }) => {
  const raw = await req.text();
  if (raw.length > 256 * 1024) return new Response(null, { status: 413 });
  const r = await handleNotionWebhook(raw, req.headers.get('x-notion-signature'));
  return new Response(null, { status: r === 'bad_signature' || r === 'not_configured' ? 401 : 200 });
});
