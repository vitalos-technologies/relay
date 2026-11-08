// V4 Platform → Support — GET /api/platform/support/attachments/:id: authorized download for support staff.
import { openStaffAttachment } from '@social-lite/services/support/attachments';
import { platformRoute } from '@/lib/api';
import { fileResponse } from '@/components/support/file-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute<{ id: string }>(async ({ p, params }) => fileResponse(await openStaffAttachment(p, params.id)));
