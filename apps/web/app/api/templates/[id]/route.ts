// PATCH /api/templates/:id { name?, body?, tags? } · DELETE /api/templates/:id (archive)
import { z } from 'zod';
import { archiveTemplate, updateTemplate } from '@social-lite/services/templates';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const patch = z.object({ name: z.string().max(200).optional(), body: z.string().max(10_000).optional(), tags: z.array(z.string().max(100)).max(50).optional() }).strict();

export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateTemplate(ctx, params.id, await parseJson(req, patch)));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => {
  await archiveTemplate(ctx, params.id);
  return { ok: true };
});
