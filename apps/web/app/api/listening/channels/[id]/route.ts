// PUT /api/listening/channels/:id { excluded } — exclude/include an inbox channel from listening (listening.manage)
import { z } from 'zod';
import { setChannelListening } from '@social-lite/services/listening/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => setChannelListening(ctx, params.id, await parseJson(req, z.object({ excluded: z.boolean() }).strict())));
