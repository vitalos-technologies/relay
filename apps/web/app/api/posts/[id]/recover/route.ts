// POST /api/posts/:id/recover — sync content recovered from browser storage. Permission and revision are re-checked;
// a newer server version is never overwritten (the content is kept as a conflict copy). Never schedules or publishes.
import { z } from 'zod';
import { recoverDraft } from '@social-lite/services/data/drafts';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  base_version: z.number().int().positive(), client_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), draft: z.unknown(),
  title: z.string().max(200).nullable().optional(), local_saved_at: z.string().max(40).nullable().optional(),
});

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => recoverDraft(ctx, params.id, await parseJson(req, body)));
