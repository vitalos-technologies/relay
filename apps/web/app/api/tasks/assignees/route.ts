// GET /api/tasks/assignees?brand_id=&q= — bounded search of people who can be assigned on a brand.
import { taskAssignees } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => taskAssignees(ctx, req.nextUrl.searchParams.get('brand_id') ?? '', req.nextUrl.searchParams.get('q') ?? ''));
