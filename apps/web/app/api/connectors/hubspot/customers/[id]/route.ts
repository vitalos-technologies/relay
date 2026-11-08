// GET /api/connectors/hubspot/customers/:id?refresh=1 — linked contact context (stored snapshot unless refresh)
import { customerCrmContext } from '@social-lite/services/integrations-v35/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => ({ context: await customerCrmContext(ctx, params.id, queryOf(req).refresh === '1') }));
