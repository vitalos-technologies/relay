// V5 WID — GET /api/widget/attachments/:id: authorized download, re-checked per request (never internal-note files).
import { openWidgetAttachment } from '@social-lite/services/support/widget';
import { fileResponse } from '@/components/support/file-response';
import { widgetRoute } from '../../_lib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = widgetRoute<{ id: string }>(async ({ params, caller }) => fileResponse(await openWidgetAttachment(caller, params.id)));
