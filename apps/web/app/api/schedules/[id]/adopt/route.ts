// POST /api/schedules/:id/adopt — an authorised publisher adopts a held publication: revalidates the
// approval/approvers, becomes the scheduling authority and re-queues (expired if past publish-before).
import { adoptPublication } from '@social-lite/services/engine/authority';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => adoptPublication(ctx, params.id));
