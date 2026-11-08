// V5 WID — POST /api/widget/attachments { filename, content_type, size, workspace_id?, reference? }: upload intent through
// the V4 quarantine pipeline (private bucket, presigned POST, server-side validation before a file can be attached).
import { widgetUploadIntent } from '@social-lite/services/support/widget';
import { widgetJson, widgetRoute } from '../_lib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = widgetRoute(async ({ req, caller }) => ({ body: await widgetUploadIntent(caller, await widgetJson(req)), status: 201 }));
