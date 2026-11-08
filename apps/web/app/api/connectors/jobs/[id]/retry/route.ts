// POST /api/connectors/jobs/:id/retry — explicit, audited retry of a failed or unconfirmed job
import { retrySyncJob } from '@social-lite/services/connectors/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => retrySyncJob(ctx, params.id));
