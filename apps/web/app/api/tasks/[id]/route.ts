// GET   /api/tasks/:id — task with followers and activity history.
// PATCH /api/tasks/:id — { expected_version, ...fields, status, assignee_id } (optimistic concurrency).
import { z } from 'zod';
import { getTask, updateTask } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  expected_version: z.number().int().min(1), title: z.string().min(1).max(200).optional(), description: z.string().max(4000).nullable().optional(),
  assignee_id: z.string().uuid().nullable().optional(), due_at: z.string().max(40).nullable().optional(), due_timezone: z.string().min(1).max(64).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), status: z.enum(['open', 'in_progress', 'blocked', 'completed', 'cancelled']).optional(),
  blocked_reason: z.string().max(500).nullable().optional(),
}).strict();
export const GET = route<{ id: string }>(async ({ ctx, params }) => getTask(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateTask(ctx, params.id, await parseJson(req, body)));
