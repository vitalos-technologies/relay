// POST /api/bulk/jobs/:id/cancel — skip the remaining pending items.
import { cancelBulk } from '@social-lite/services/data/bulk';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => cancelBulk(ctx, params.id));
