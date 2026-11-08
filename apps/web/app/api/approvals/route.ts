// GET /api/approvals?status=pending|decided&brand_id= — V2 approval inbox (stream C): brand/assignee/due grouping data.
import { approvalInbox } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => approvalInbox(ctx, { status: req.nextUrl.searchParams.get('status'), brand_id: req.nextUrl.searchParams.get('brand_id') }));
