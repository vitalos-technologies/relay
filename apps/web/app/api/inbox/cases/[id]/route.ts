// GET /api/inbox/cases/:id · PATCH { version, state?, resolution_reason?, priority?, owner_id?, title?, category? } (409 on stale version)
import { getCase, updateCase, updateCaseSchema } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getCase(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateCase(ctx, params.id, await parseJson(req, updateCaseSchema)));
