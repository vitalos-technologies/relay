// GET /api/admin/deliveries/:id — delivery evidence + which recovery actions apply (actions use the existing routes).
import { adminDeliveryDetail } from '@social-lite/services/admin/publishing';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => adminDeliveryDetail(ctx, params.id));
