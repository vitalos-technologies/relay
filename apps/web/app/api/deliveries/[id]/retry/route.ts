import { z } from 'zod';
import { retryDelivery } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ acknowledge_duplicate_risk: z.boolean().optional(), deadline_minutes: z.number().int().min(1).max(10080).optional() });
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => retryDelivery(ctx, params.id, await parseJson(req, body)));
