// GET /api/content-hub/writebacks?brand_id&status
import * as ch from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => ch.listWritebacks(ctx, req.nextUrl.searchParams.get('brand_id') ?? '', { status: req.nextUrl.searchParams.get('status') }));
