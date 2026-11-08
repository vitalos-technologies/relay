// GET /api/connectors/gbp/posts?post_id= · POST — Google local posts for a post's schedule (≤ 10 locations; count confirmed; follows approval)
import { gbpPostSchema, listGbpLocalPosts, requestGbpLocalPosts } from '@social-lite/services/integrations-v35/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listGbpLocalPosts(ctx, queryOf(req).post_id ?? ''));
export const POST = route(async ({ req, ctx }) => requestGbpLocalPosts(ctx, await parseJson(req, gbpPostSchema)));
