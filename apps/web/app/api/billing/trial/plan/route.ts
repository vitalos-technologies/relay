// POST /api/billing/trial/plan { plan } — switch the plan of the running trial; the end date never changes (billing.manage).
import { z } from 'zod';
import { changeTrialPlan } from '@social-lite/services/billing/manage';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => changeTrialPlan(ctx, await parseJson(req, z.unknown())));
