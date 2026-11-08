// GET/POST /api/brands/:id/campaigns — brand-scoped campaigns.
import { z } from 'zod';
import { createCampaign, listCampaigns } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ name: z.string().min(1).max(120), description: z.string().max(2000).nullable().optional(), starts_on: z.string().max(10).nullable().optional(), ends_on: z.string().max(10).nullable().optional() }).strict();
export const GET = route<{ id: string }>(async ({ req, ctx, params }) => listCampaigns(ctx, params.id, { archived: req.nextUrl.searchParams.get('archived') === '1' }));
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => createCampaign(ctx, params.id, await parseJson(req, body)));
