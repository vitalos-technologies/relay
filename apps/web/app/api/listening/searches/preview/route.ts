// POST /api/listening/searches/preview — test a definition against stored mentions (last 30 days) without saving
import { previewSchema, previewSearch } from '@social-lite/services/listening/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => previewSearch(ctx, await parseJson(req, previewSchema)));
