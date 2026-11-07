// POST /api/members/:userId/suspend { reason? } — temporary suspension (distinct from removal).
import { z } from 'zod';
import { suspendMember } from '@social-lite/services/lifecycle';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ reason: z.string().max(300).nullable().optional() }).strict();

export const POST = route<{ userId: string }>(async ({ req, ctx, params }) => suspendMember(ctx, params.userId, await parseJson(req, body)));
