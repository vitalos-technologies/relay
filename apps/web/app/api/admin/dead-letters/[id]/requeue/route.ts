// POST /api/admin/dead-letters/:id/requeue — requeue one dead event (safe types only; repeated clicks requeue once).
import { requeueDeadLetter } from '@social-lite/services/admin/publishing';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => requeueDeadLetter(ctx, params.id));
