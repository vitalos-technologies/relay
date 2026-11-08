// GET /api/platform/billing/workspaces/:id — billing record: state, provider refs + links, trial, invoices, lifecycle (operator / billing staff).
import { platformBillingDetail } from '@social-lite/services/billing/platform';
import { platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute<{ id: string }>(async ({ p, params }) => platformBillingDetail(p, params.id));
