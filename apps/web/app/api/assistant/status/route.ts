// GET /api/assistant/status → {configured, reason, provider, can_use, period, used, cap, remaining}. Never reveals the key.
import { assistantStatus } from '@social-lite/services/assistant/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => assistantStatus(ctx));
