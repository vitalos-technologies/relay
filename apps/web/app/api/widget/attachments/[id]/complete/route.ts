// V5 WID — POST /api/widget/attachments/:id/complete: validate the uploaded bytes (type, size, signature) — owner only.
import { widgetCompleteUpload } from '@social-lite/services/support/widget';
import { widgetRoute } from '../../../_lib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = widgetRoute<{ id: string }>(async ({ params, caller }) => ({ body: await widgetCompleteUpload(caller, params.id) }));
