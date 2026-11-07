// GET /api/content-hub/connections/:id/picker?brand_id= → Picker config (API key, app id, client id). Never a token.
import * as ch from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => ch.pickerConfig(ctx, params.id, req.nextUrl.searchParams.get('brand_id') ?? ''));
