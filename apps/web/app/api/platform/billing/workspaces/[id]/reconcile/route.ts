// POST /api/platform/billing/workspaces/:id/reconcile — re-fetch provider state now (billing staff).
import { staffReconcile } from '@social-lite/services/billing/platform';
import { platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ id: string }>(async ({ p, params }) => staffReconcile(p, params.id));
