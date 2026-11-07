// POST /api/approvals/:id/assignment — reviewer assignee + review due date (planning only; grants nothing).
import { z } from 'zod';
import { assignReview } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ assignee_user_id: z.string().uuid().nullable().optional(), due_at: z.string().max(40).nullable().optional() }).strict();
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => assignReview(ctx, params.id, await parseJson(req, body)));
