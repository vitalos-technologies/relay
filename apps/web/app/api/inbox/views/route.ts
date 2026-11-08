// GET /api/inbox/views · POST { name, filters } — personal saved views
import { createSavedView, listSavedViews, savedViewSchema } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listSavedViews(ctx));
export const POST = route(async ({ req, ctx }) => createSavedView(ctx, await parseJson(req, savedViewSchema)));
