// GET /api/trash/consequences?kind=&id= — what deleting this item means (shown before confirming).
import { z } from 'zod';
import { trashConsequences } from '@social-lite/services/data/trash';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const q = z.object({ kind: z.enum(['post', 'asset']), id: z.string().uuid() });

export const GET = route(async ({ req, ctx }) => {
  const p = q.parse(Object.fromEntries(req.nextUrl.searchParams));
  return trashConsequences(ctx, p.kind, p.id);
});
