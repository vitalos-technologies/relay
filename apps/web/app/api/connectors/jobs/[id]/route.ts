// GET /api/connectors/jobs/:id — sync job state (queued … succeeded | failed | unknown)
import { getSyncJob } from '@social-lite/services/connectors/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getSyncJob(ctx, params.id));
