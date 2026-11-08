// GET /api/platform/billing/plans — persisted catalogue: plans, immutable versions, provider prices, drift (any staff).
// POST { plan_id, reason } — publish the catalogue file's definition as a new version (operator, step-up).
import { z } from 'zod';
import { platformPlans, publishPlanVersion } from '@social-lite/services/billing/platform';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ p }) => platformPlans(p));
export const POST = platformRoute(async ({ req, p }) => publishPlanVersion(p, await parseJson(req, z.unknown())));
