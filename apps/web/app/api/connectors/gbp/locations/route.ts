// GET /api/connectors/gbp/locations?brand_id= — selected Google Business Profile locations (also used by the inbox for reviews)
import { listGbpLocations } from '@social-lite/services/integrations-v35/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listGbpLocations(ctx, { brandId: queryOf(req).brand_id ?? null }));
