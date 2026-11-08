import { z } from 'zod';
import { resolveDelivery } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ outcome: z.enum(['published', 'not_published']), provider_url: z.string().url().max(2048).optional(), note: z.string().max(300).optional() });
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => resolveDelivery(ctx, params.id, await parseJson(req, body)));
