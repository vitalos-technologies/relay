// GET /api/ops/workload?window_minutes=60 — V3.1 workload classes, publishing pressure, queue age vs dispatch delay vs
// processing time (provider time separate). Contract: packages/core/src/contracts/v31-perf.ts. Permission: diagnostics.read.
import { workloadStats } from '@social-lite/services/workload/stats';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => workloadStats(ctx, { window_minutes: req.nextUrl.searchParams.get('window_minutes') }));
