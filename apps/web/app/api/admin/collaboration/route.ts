// GET /api/admin/collaboration — tasks, review backlog, reassignment counts, notification delivery (admins only).
import { collabAdminOverview } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => collabAdminOverview(ctx));
