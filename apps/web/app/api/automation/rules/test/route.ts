// POST /api/automation/rules/test (rule body) → dry run over recent data in scope. Changes and sends nothing.
import { ruleSchema, testRule } from '@social-lite/services/automation/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => testRule(ctx, await parseJson(req, ruleSchema)));
