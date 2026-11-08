// PATCH /api/campaigns/:id — rename, dates, archive.
import { z } from 'zod';
import { updateCampaign } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ name: z.string().min(1).max(120).optional(), description: z.string().max(2000).nullable().optional(), starts_on: z.string().max(10).nullable().optional(), ends_on: z.string().max(10).nullable().optional(), archived: z.boolean().optional() }).strict();
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateCampaign(ctx, params.id, await parseJson(req, body)));
