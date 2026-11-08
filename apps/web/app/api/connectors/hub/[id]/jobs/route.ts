// GET /api/connectors/hub/:id/jobs — recent sync jobs (state, attempts, errors)
import { listIntegrationJobs } from '@social-lite/services/integrations-v35/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => listIntegrationJobs(ctx, params.id));
