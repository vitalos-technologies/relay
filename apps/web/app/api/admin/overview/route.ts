// GET /api/admin/overview — workspace admin overview (V3.1 Admin §6). workspace.read; cards filtered by permission.
import { adminOverview } from '@social-lite/services/admin/overview';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => adminOverview(ctx));
