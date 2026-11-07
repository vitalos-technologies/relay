// POST /api/content-hub/items/:id/hold { hold }
import { z } from 'zod';
import * as ch from '@social-lite/services/content-hub/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ hold: z.boolean() }).strict();
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => ch.setRetentionHold(ctx, params.id, (await parseJson(req, body)).hold));
