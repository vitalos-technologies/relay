// GET /api/bulk/jobs/:id — status + per-item results (items on brands the caller can no longer read are omitted).
import { getBulkJob } from '@social-lite/services/data/bulk';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getBulkJob(ctx, params.id));
