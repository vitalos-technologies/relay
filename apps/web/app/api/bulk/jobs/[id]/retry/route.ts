// POST /api/bulk/jobs/:id/retry { item_ids? } — re-run failed items only (successes are never re-run).
import { z } from 'zod';
import { retryBulk } from '@social-lite/services/data/bulk';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ item_ids: z.array(z.string().uuid()).max(500).optional() });

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => retryBulk(ctx, params.id, (await parseJson(req, body)).item_ids));
