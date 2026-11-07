// POST /api/review/:id/approve — explicit approval (never triggered by a link or notification click).
import { z } from 'zod';
import { reviewApprove } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ expected_fingerprint: z.string().min(8).max(64) }).strict();
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => reviewApprove(ctx, params.id, (await parseJson(req, body)).expected_fingerprint));
