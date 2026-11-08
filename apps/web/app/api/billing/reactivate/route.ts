// POST /api/billing/reactivate — undo a scheduled cancellation before the period ends (billing.manage).
import { reactivateRenewal } from '@social-lite/services/billing/manage';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ ctx }) => reactivateRenewal(ctx));
