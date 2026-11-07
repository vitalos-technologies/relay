// GET /api/ai/status → {configured, reason, fixture, model, can_use, period, used, cap, remaining}
// Workspace-level; never reveals the key or where it is stored.
import { aiStatus } from '@social-lite/services/ai/index';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => aiStatus(ctx));
