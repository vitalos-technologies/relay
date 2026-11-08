// GET /api/platform/billing?status=&q= — subscriptions across workspaces (operator / billing staff).
import { listPlatformBilling } from '@social-lite/services/billing/platform';
import { platformRoute, queryOf } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ req, p }) => listPlatformBilling(p, queryOf(req)));
