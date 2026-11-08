// V4 Platform → Support — POST /api/platform/support/attachments/:id/complete: validate the uploaded bytes.
import { completeStaffUpload } from '@social-lite/services/support/attachments';
import { platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ id: string }>(async ({ p, params }) => completeStaffUpload(p, params.id));
