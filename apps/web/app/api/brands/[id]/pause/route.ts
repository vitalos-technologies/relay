// POST /api/brands/:id/pause { paused, reason? } (owner/admin/approver)
import { z } from 'zod';
import { setBrandPaused } from '@social-lite/services/brands';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ paused: z.boolean(), reason: z.string().max(500).nullish() }).strict();

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => setBrandPaused(ctx, params.id, await parseJson(req, body)));
