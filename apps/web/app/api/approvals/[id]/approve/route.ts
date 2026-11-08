import { z } from 'zod';
import { approve } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ expected_fingerprint: z.string().min(8).max(64) });
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => approve(ctx, params.id, (await parseJson(req, body)).expected_fingerprint));
