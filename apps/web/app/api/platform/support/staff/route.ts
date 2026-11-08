// V4 Platform → Support — GET /api/platform/support/staff: active support staff (assignment targets).
import { listSupportStaff } from '@social-lite/services/support/staff';
import { platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ p }) => listSupportStaff(p));
