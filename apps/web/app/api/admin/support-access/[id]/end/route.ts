// POST /api/admin/support-access/:id/end — workspace ends (or cancels) support access now. members.manage.
import { workspaceEndSupportAccess } from '@social-lite/services/admin/support-access';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => workspaceEndSupportAccess(ctx, params.id));
