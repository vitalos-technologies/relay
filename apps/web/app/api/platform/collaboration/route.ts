// GET /api/platform/collaboration — collaboration pipeline health across the installation (aggregates only). support+.
import { platformCollabHealth } from '@social-lite/services';
import { platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async () => platformCollabHealth());
