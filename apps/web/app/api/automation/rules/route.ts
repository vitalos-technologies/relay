// GET /api/automation/rules?policy_id= · POST (create). automation.manage.
import { createRule, listRules, ruleSchema } from '@social-lite/services/automation/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listRules(ctx, queryOf(req) as never));
export const POST = route(async ({ req, ctx }) => createRule(ctx, await parseJson(req, ruleSchema)));
