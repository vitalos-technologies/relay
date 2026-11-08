// POST /api/connectors/hub/:id/webhook { resource_id? } — Asana/monday: register "receive updates" on a project/board; Mailchimp: issue the webhook URL (key shown once)
import { z } from 'zod';
import { issueMailchimpWebhookUrl, registerTaskWebhook } from '@social-lite/services/integrations-v35/index';
import { loadIntegration } from '@social-lite/services/connectors/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ resource_id: z.string().uuid().optional() }).strict();
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  const b = await parseJson(req, body);
  const integ = await loadIntegration(ctx, params.id, 'integrations.manage');
  if (integ.connector === 'mailchimp') return issueMailchimpWebhookUrl(ctx, params.id);
  return registerTaskWebhook(ctx, params.id, b.resource_id ?? '');
});
