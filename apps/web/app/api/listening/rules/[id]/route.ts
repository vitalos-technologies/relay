// PATCH /api/listening/rules/:id { …, expected_version } · DELETE (archive)
import { archiveRule, updateRule, updateRuleSchema } from '@social-lite/services/listening/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateRule(ctx, params.id, await parseJson(req, updateRuleSchema)));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => archiveRule(ctx, params.id));
