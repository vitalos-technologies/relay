// GET /api/billing — Settings → Billing overview (billing.read). Stored state only; no provider call.
import { billingOverview } from '@social-lite/services/billing/manage';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => billingOverview(ctx));
