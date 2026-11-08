// DELETE /api/assistant/attachments/:id
import { removeAttachment } from '@social-lite/services/ai-workflows/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => removeAttachment(ctx, params.id));
