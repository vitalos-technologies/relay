// V3.1 §14 — GET /api/campaigns/:id/measurement — native social metrics, app-observed clicks, website events and
// attributed conversions, kept separate (never summed; unimplemented families are labelled, never estimated).
import { campaignMeasurement } from '@social-lite/services/gov/links';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => campaignMeasurement(ctx, params.id));
