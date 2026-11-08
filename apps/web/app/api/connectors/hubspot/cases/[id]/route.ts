// GET /api/connectors/hubspot/cases/:id?refresh=1 — ticket linked to a case (+ job state)
import { caseTicket } from '@social-lite/services/integrations-v35/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => caseTicket(ctx, params.id, queryOf(req).refresh === '1'));
