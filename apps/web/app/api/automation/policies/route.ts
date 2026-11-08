// GET /api/automation/policies · POST (create as draft). automation.manage.
import { createPolicy, listPolicies, policySchema } from '@social-lite/services/automation/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listPolicies(ctx));
export const POST = route(async ({ req, ctx }) => createPolicy(ctx, await parseJson(req, policySchema)));
