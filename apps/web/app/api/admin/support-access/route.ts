// GET /api/admin/support-access — support access requests/grants for this workspace. members.read.
import { listWorkspaceSupportAccess } from '@social-lite/services/admin/support-access';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listWorkspaceSupportAccess(ctx));
