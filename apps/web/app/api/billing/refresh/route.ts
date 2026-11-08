// POST /api/billing/refresh — re-fetch this workspace's checkout/subscription/invoices from the provider (billing.read).
import { refreshBilling } from '@social-lite/services/billing/manage';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ ctx }) => refreshBilling(ctx));
