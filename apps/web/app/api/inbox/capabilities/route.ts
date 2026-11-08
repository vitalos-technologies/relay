// GET /api/inbox/capabilities — per-channel capability record (provider support vs what Relay implements).
import { capabilityMatrix } from '@social-lite/services/inbox/index';
import { requireAction } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => { requireAction(ctx, 'inbox.read'); return { items: capabilityMatrix() }; });
