// PUT /api/posts/:id/autosave — V3.1 debounced autosave (base_version + per-tab client_revision). 409 version_conflict
// carries the current server copy (details.current) and the kept conflict copy id. Contract: core/contracts/v31-data.ts.
import { z } from 'zod';
import { autosaveDraft } from '@social-lite/services/data/drafts';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  base_version: z.number().int().positive(), client_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), client_revision: z.number().int().nonnegative(),
  draft: z.unknown().optional(), title: z.string().max(200).nullable().optional(),
});

export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => autosaveDraft(ctx, params.id, await parseJson(req, body)));
