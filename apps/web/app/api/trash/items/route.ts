// POST /api/trash/items — move a post or asset to Trash. Returns an undo token (POST /api/trash/restore).
import { z } from 'zod';
import { trashItem } from '@social-lite/services/data/trash';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ kind: z.enum(['post', 'asset']), id: z.string().uuid(), expected_version: z.number().int().positive().nullable().optional() });

export const POST = route(async ({ req, ctx }) => {
  const b = await parseJson(req, body);
  return trashItem(ctx, b.kind, b.id, { expectedVersion: b.expected_version ?? null });
});
