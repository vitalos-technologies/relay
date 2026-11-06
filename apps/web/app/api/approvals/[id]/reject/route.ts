import { z } from 'zod';
import { reject } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ reason: z.string().max(2000) });
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => reject(ctx, params.id, (await parseJson(req, body)).reason));
