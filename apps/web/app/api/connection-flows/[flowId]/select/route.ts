// POST /api/connection-flows/:flowId/select { provider_account_ids } — AC-02 explicit choice.
import { selectConnectionFlow, selectFlowSchema } from '@social-lite/services/connections/index';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ flowId: string }>(async ({ req, ctx, params }) => selectConnectionFlow(ctx, params.flowId, await parseJson(req, selectFlowSchema)));
