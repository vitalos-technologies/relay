// GET /api/platform/flags — feature flag rollouts (installation rows). support+.
import { listPlatformFlags } from '@social-lite/services/admin/platform';
import { platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ p }) => listPlatformFlags(p));
