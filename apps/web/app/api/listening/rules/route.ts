// POST /api/listening/rules — create a spike alert rule (listening.manage)
import { createRule, ruleSchema } from '@social-lite/services/listening/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => createRule(ctx, await parseJson(req, ruleSchema)));
