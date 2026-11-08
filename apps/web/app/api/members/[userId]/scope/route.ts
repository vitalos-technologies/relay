// POST /api/members/:userId/scope { brand_ids } — scope reduction: revoke direct grants on these brands.
import { z } from 'zod';
import { reduceScope } from '@social-lite/services/lifecycle';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ brand_ids: z.array(z.string().max(64)).min(1).max(200) }).strict();

export const POST = route<{ userId: string }>(async ({ req, ctx, params }) => reduceScope(ctx, params.userId, await parseJson(req, body)));
