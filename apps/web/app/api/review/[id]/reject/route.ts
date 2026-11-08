// POST /api/review/:id/reject — request changes (reason required).
import { z } from 'zod';
import { reviewReject } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ reason: z.string().max(2000) }).strict();
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => reviewReject(ctx, params.id, (await parseJson(req, body)).reason));
