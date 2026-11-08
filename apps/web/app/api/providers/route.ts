// GET /api/providers — provider app configuration status (no secrets).
import { listProviderStatus } from '@social-lite/services/connections/index';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listProviderStatus(ctx));
