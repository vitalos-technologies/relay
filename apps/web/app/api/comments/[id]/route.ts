// DELETE /api/comments/:id — author (or brand manager) removes a comment.
import { deleteComment } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => deleteComment(ctx, params.id));
