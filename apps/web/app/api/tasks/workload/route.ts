// GET /api/tasks/workload?brand_id= — my counts + team workload (open / overdue / due this week per assignee).
import { taskWorkload } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => taskWorkload(ctx, { brand_id: req.nextUrl.searchParams.get('brand_id') }));
