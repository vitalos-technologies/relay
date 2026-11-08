// GET /api/content-hub/status → ContentHubSourceStatus[] (configuration readiness; no secret values).
import { contentHubStatus } from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => contentHubStatus(ctx));
