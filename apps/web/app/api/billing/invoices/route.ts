// GET /api/billing/invoices — provider invoice links cached from verified events (billing.read).
import { listInvoices } from '@social-lite/services/billing/manage';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listInvoices(ctx));
