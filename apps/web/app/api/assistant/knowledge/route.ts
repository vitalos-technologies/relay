// GET /api/assistant/knowledge?brand_id= · POST {brand_id, kind, ref_id, topics?, review_by?} (brands.manage on the brand)
import { approveKnowledge, knowledgeSchema, listKnowledge } from '@social-lite/services/assistant/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listKnowledge(ctx, queryOf(req) as never));
export const POST = route(async ({ req, ctx }) => approveKnowledge(ctx, await parseJson(req, knowledgeSchema)));
