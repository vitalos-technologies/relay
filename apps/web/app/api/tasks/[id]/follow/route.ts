// POST /api/tasks/:id/follow · DELETE /api/tasks/:id/follow — follow / unfollow a task.
import { setTaskFollowing } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => setTaskFollowing(ctx, params.id, true));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => setTaskFollowing(ctx, params.id, false));
