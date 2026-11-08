// GET /api/connectors/hub/:id — installation detail (setup, resources) · DELETE — disconnect (provider revoke where offered; links kept as unavailable)
import { disconnectHubIntegration, installationDetail } from '@social-lite/services/integrations-v35/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => installationDetail(ctx, params.id));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => disconnectHubIntegration(ctx, params.id));
