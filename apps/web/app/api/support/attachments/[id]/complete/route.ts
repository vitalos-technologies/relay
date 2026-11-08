// V4 Relay support — POST /api/support/attachments/:id/complete: validate the uploaded bytes (type, size, signature) → ready | rejected.
import { completeCustomerUpload } from '@social-lite/services/support/attachments';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => completeCustomerUpload(ctx, params.id));
