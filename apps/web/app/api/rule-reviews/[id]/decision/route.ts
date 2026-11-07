// V3.1 §12 — POST /api/rule-reviews/:id/decision { decision: keep|will_edit|cancel_schedule, note? } — explicit, audited.
import { z } from 'zod';
import { decideRuleReview } from '@social-lite/services/gov/brand-rules';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => decideRuleReview(ctx, params.id, await parseJson(req, z.unknown())));
