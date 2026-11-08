// GET /api/trash?kind=post|asset&brand_id=&cursor=&limit= — trashed items the caller can read.
import { z } from 'zod';
import { listTrash } from '@social-lite/services/data/trash';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const q = z.object({ kind: z.enum(['post', 'asset']).optional(), brand_id: z.string().uuid().optional(), cursor: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

export const GET = route(async ({ req, ctx }) => listTrash(ctx, q.parse(Object.fromEntries(req.nextUrl.searchParams))));
