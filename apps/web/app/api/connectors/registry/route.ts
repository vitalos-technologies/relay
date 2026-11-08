// GET /api/connectors/registry — connector definitions (scopes, inbound mechanism, prerequisites, docs checked date).
import { CONNECTORS } from '@social-lite/services/connectors/index';
import { requireAction } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => { requireAction(ctx, 'integrations.read'); return { items: Object.values(CONNECTORS).map(({ hosts: _h, ...d }) => d) }; });
