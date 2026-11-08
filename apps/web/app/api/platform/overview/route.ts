// GET /api/platform/overview — installation health (aggregates only). support+.
import { platformOverview } from '@social-lite/services/admin/platform';
import { platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ p }) => platformOverview(p));
