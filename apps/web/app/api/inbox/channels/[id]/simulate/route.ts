// POST /api/inbox/channels/:id/simulate { kind: dm|comment, text, name?, thread?, minutes_ago? } — SIMULATED channels only;
// refused in production. Goes through the same parser + ingestion as a verified webhook.
import { simulateInbound, simulateSchema } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => simulateInbound(ctx, params.id, await parseJson(req, simulateSchema)));
