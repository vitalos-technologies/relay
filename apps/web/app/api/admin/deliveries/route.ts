// GET /api/admin/deliveries — per-destination publishing operations list (V3.1 Admin §8). content.read, brand-scoped.
import { adminDeliveries } from '@social-lite/services/admin/publishing';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => adminDeliveries(ctx, queryOf(req)));
