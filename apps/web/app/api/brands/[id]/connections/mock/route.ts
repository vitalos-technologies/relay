// POST /api/brands/:id/connections/mock { provider, display_name, scenario? } — simulated destination (dev/demo only).
import { connectMock, mockConnectSchema } from '@social-lite/services/connections/index';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => connectMock(ctx, params.id, await parseJson(req, mockConnectSchema)));
