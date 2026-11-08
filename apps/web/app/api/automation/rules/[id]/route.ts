// GET /api/automation/rules/:id · PUT (full rule, ?version= for optimistic concurrency) · DELETE
import { deleteRule, getRule, ruleSchema, updateRule } from '@social-lite/services/automation/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getRule(ctx, params.id));
export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => updateRule(ctx, params.id, await parseJson(req, ruleSchema), Number(queryOf(req).version) || null));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => { await deleteRule(ctx, params.id); return { ok: true }; });
