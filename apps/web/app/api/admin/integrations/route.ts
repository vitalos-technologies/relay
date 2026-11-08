// GET /api/admin/integrations — integration health + sync lag per installation (integrationHealth), Slack delivery and
// translation usage (diagnostics.read). Counts, states and safe error codes only.
import { integrationsAdminOverview } from '@social-lite/services/admin/v35';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => integrationsAdminOverview(ctx));
