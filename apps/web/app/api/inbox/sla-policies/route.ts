// GET /api/inbox/sla-policies (+ definitions) · POST (create or update with id) — inbox.manage
import { listSlaPolicies, slaPolicySchema, upsertSlaPolicy } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listSlaPolicies(ctx));
export const POST = route(async ({ req, ctx }) => upsertSlaPolicy(ctx, await parseJson(req, slaPolicySchema)));
