// GET /api/connectors/:id — health (events, jobs, activity, rate limits) · PATCH { paused, reason? } · DELETE (disconnect; links kept as unavailable)
import { z } from 'zod';
import { disconnectIntegration, integrationHealth, setIntegrationPaused } from '@social-lite/services/connectors/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ paused: z.boolean(), reason: z.string().max(200).nullable().optional() }).strict();
export const GET = route<{ id: string }>(async ({ ctx, params }) => integrationHealth(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => { const b = await parseJson(req, body); return setIntegrationPaused(ctx, params.id, b.paused, b.reason); });
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => { await disconnectIntegration(ctx, params.id); return { ok: true }; });
