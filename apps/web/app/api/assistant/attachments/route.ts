// GET /api/assistant/attachments?brand_id= · POST {brand_id, filename, mime, text} — small text files (≤ 256 KB) used as
// untrusted sources for my tasks. Private to me; text purged after 30 days.
import { addAttachment, attachmentSchema, listAttachments } from '@social-lite/services/ai-workflows/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listAttachments(ctx, queryOf(req)));
export const POST = route(async ({ req, ctx }) => addAttachment(ctx, await parseJson(req, attachmentSchema)));
