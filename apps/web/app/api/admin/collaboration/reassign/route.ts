// GET  /api/admin/collaboration/reassign — work held by people who lost access.
// POST /api/admin/collaboration/reassign { from_user_id, to_user_id, include? } — move open work (members.manage).
import { z } from 'zod';
import { reassignmentWork, reassignWork } from '@social-lite/services';
import { requireAction } from '@social-lite/services/tenancy';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ from_user_id: z.string().uuid(), to_user_id: z.string().uuid().nullable(), include: z.array(z.enum(['tasks', 'reviews', 'posts'])).max(3).optional() }).strict();
export const GET = route(async ({ ctx }) => { requireAction(ctx, 'content.read'); return reassignmentWork(ctx); });
export const POST = route(async ({ req, ctx }) => reassignWork(ctx, await parseJson(req, body)));
