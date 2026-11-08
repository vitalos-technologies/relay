// V4 Relay support — GET /api/support/attachments/:id: authorized download (re-checked per request; never internal-note files).
import { openCustomerAttachment } from '@social-lite/services/support/attachments';
import { route } from '@/lib/api';
import { fileResponse } from '@/components/support/file-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => fileResponse(await openCustomerAttachment(ctx, params.id)));
