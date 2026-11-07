// GET  /api/tasks?view=mine|created|team&status=open|done|all&due=overdue|upcoming|none|reassign&brand_id&post_id&approval_id&assignee_id&cursor
// POST /api/tasks — create a task linked to a post, campaign or review request.
import { z } from 'zod';
import { createTask, listTasks } from '@social-lite/services';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  brand_id: z.string().uuid().nullable().optional(), post_id: z.string().uuid().nullable().optional(), campaign_id: z.string().uuid().nullable().optional(),
  approval_id: z.string().uuid().nullable().optional(), title: z.string().min(1).max(200), description: z.string().max(4000).nullable().optional(),
  assignee_id: z.string().uuid().nullable().optional(), due_at: z.string().max(40).nullable().optional(), due_timezone: z.string().min(1).max(64).nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), follower_ids: z.array(z.string().uuid()).max(20).optional(),
}).strict();
export const GET = route(async ({ req, ctx }) => {
  const q = queryOf(req);
  return listTasks(ctx, { ...q, limit: q.limit ? Number(q.limit) : null });
});
export const POST = route(async ({ req, ctx }) => createTask(ctx, await parseJson(req, body)));
