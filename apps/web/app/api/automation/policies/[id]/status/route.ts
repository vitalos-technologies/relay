// POST /api/automation/policies/:id/status {status: active|paused|stopped, reason?} — activating makes you the owner.
import { z } from 'zod';
import { setPolicyStatus } from '@social-lite/services/automation/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const schema = z.object({ status: z.enum(['active', 'paused', 'stopped']), reason: z.string().trim().max(300).nullish() }).strict();
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => { const b = await parseJson(req, schema); return setPolicyStatus(ctx, params.id, b.status, b.reason); });
