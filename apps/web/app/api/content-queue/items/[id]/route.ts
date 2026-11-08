// V3.1 §13 — DELETE /api/content-queue/items/:id — remove a queued item (scheduled items: cancel the schedule instead).
import { removeFromContentQueue } from '@social-lite/services/gov/reuse';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => removeFromContentQueue(ctx, params.id));
