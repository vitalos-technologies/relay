// V5 WID — POST /api/widget/conversations/:ref/messages { client_id, body, attachment_ids?, after? }: reply (deduplicated
// by client_id). Reopens a recently resolved conversation like the V4 customer flow.
import { sendMessage } from '@social-lite/services/support/widget';
import { widgetJson, widgetRoute } from '../../../_lib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = widgetRoute<{ ref: string }>(async ({ req, params, caller }) => ({ body: await sendMessage(caller, params.ref, await widgetJson(req)) }));
