// POST /api/v1/drafts { brand_id, title?, text } — create a DRAFT as the calling service account.
// Requires content.create_draft on that brand (integration preset). Never schedules or publishes.
import { z } from 'zod';
import { createIntegrationDraft } from '@social-lite/services/integrations/drafts';
import { parseJson } from '@/lib/api';
import { machineRoute } from '@/lib/machine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ brand_id: z.string().uuid(), title: z.string().trim().max(200).nullish(), text: z.string().min(1).max(10_000) }).strict();

export const POST = machineRoute(async ({ req, ctx, principal }) => {
  const input = await parseJson(req, body);
  const post = await createIntegrationDraft(ctx, principal.serviceAccountId, input.brand_id, { title: input.title || 'API draft', text: input.text, source: { kind: 'api' }, tags: ['api'] });
  return { id: post.id, status: 'draft' };
});
