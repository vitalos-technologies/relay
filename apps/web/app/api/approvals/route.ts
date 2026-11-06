import { listApprovals } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listApprovals(ctx, req.nextUrl.searchParams.get('status') === 'decided' ? 'decided' : 'pending'));
