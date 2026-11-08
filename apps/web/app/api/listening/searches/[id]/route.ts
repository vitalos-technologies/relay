// GET /api/listening/searches/:id (+ versions) · PATCH { …definition, expected_version } · DELETE (archive)
import { archiveSearch, getSearch, updateSearch, updateSearchSchema } from '@social-lite/services/listening/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getSearch(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateSearch(ctx, params.id, await parseJson(req, updateSearchSchema)));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => archiveSearch(ctx, params.id));
