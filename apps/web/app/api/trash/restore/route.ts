// POST /api/trash/restore — restore from Trash (permission re-checked; never republishes). expected_deleted_at = undo check.
import { z } from 'zod';
import { restoreItem } from '@social-lite/services/data/trash';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ kind: z.enum(['post', 'asset']), id: z.string().uuid(), expected_deleted_at: z.string().max(40).nullable().optional() });

export const POST = route(async ({ req, ctx }) => {
  const b = await parseJson(req, body);
  return restoreItem(ctx, b.kind, b.id, { expectedDeletedAt: b.expected_deleted_at ?? null });
});
