// GET /api/automation/policies/:id · PATCH (full policy; editing an active policy pauses it).
import { getPolicy, policySchema, updatePolicy } from '@social-lite/services/automation/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getPolicy(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updatePolicy(ctx, params.id, await parseJson(req, policySchema)));
