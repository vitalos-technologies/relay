// GET /api/platform/workspaces?q=&state=&demo=&cursor= — workspace metadata list. support+.
import { listPlatformWorkspaces } from '@social-lite/services/admin/platform';
import { platformRoute, queryOf } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ req, p }) => listPlatformWorkspaces(p, queryOf(req)));
