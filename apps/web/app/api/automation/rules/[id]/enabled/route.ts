// POST /api/automation/rules/:id/enabled {enabled}
import { z } from 'zod';
import { setRuleEnabled } from '@social-lite/services/automation/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => setRuleEnabled(ctx, params.id, (await parseJson(req, z.object({ enabled: z.boolean() }).strict())).enabled));
