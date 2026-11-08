// V4 Platform → Support — GET /api/platform/support/tickets?queue=&q=&category=&priority=&source=&assignee=&workspace_id=&cursor= (support staff).
import { listStaffTickets } from '@social-lite/services/support/staff';
import { platformRoute, queryOf } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ req, p }) => listStaffTickets(p, queryOf(req)));
