// POST /api/platform/billing/workspaces/:id/trial { days, reason } — extend an eligible no-card trial (billing staff, step-up, both audits).
import { z } from 'zod';
import { staffExtendTrial } from '@social-lite/services/billing/platform';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ id: string }>(async ({ req, p, params }) => staffExtendTrial(p, params.id, await parseJson(req, z.unknown())));
