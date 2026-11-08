// GET /api/listening/searches?brand_id= · POST /api/listening/searches (listening.manage)
import { createSearch, createSearchSchema, listSearches } from '@social-lite/services/listening/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listSearches(ctx, queryOf(req)));
export const POST = route(async ({ req, ctx }) => createSearch(ctx, await parseJson(req, createSearchSchema)));
