// GET  /api/inbox/cases?state=&brand_id=&owner=me · POST /api/inbox/cases { conversation_id, title, category?, priority?, owner_id?, sla_policy_id? }
import { createCase, createCaseSchema, listCases } from '@social-lite/services/inbox/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listCases(ctx, queryOf(req)));
export const POST = route(async ({ req, ctx }) => createCase(ctx, await parseJson(req, createCaseSchema)));
