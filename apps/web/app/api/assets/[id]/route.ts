// GET /api/assets/:id · PATCH /api/assets/:id { alt_text?, tags? }
import { z } from 'zod';
import { getAsset, updateAsset } from '@social-lite/services/media/assets';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const patch = z.object({ alt_text: z.string().max(1500).nullable().optional(), tags: z.array(z.string().max(100)).max(50).optional() }).strict();

export const GET = route<{ id: string }>(async ({ ctx, params }) => getAsset(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateAsset(ctx, params.id, await parseJson(req, patch)));
