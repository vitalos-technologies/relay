// GET /api/connectors/hub/:id/discover?type=&parent= — resources the provider offers for EXPLICIT selection (nothing imported)
import { discoverResources } from '@social-lite/services/integrations-v35/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => { const q = queryOf(req); return discoverResources(ctx, params.id, { type: q.type?.slice(0, 40) ?? null, parent: q.parent?.slice(0, 200) ?? null }); });
