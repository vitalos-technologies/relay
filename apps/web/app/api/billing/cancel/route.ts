// POST /api/billing/cancel — cancel renewal at period end (billing.manage). Service continues until then; nothing is deleted.
import { cancelRenewal } from '@social-lite/services/billing/manage';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ ctx }) => cancelRenewal(ctx));
