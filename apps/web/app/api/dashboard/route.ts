import { dashboard } from '@social-lite/services/readmodels';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => dashboard(ctx, { brand_id: req.nextUrl.searchParams.get('brand_id') ?? undefined }));
