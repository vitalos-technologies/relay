// GET /api/admin/jobs — V3.1 Admin read model (stored data only; see services/admin/reads.ts for permissions).
import { adminJobs } from '@social-lite/services/admin/reads';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => adminJobs(ctx, queryOf(req)));
