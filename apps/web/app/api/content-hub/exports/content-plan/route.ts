// POST /api/content-hub/exports/content-plan { brand_id, campaign_id?, destination, title? }
import { z } from 'zod';
import * as ch from '@social-lite/services/content-hub/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  brand_id: z.string().uuid(), campaign_id: z.string().uuid().nullish(), title: z.string().max(200).optional(),
  destination: z.object({ kind: z.enum(['google_doc', 'drive_file', 'notion_page']), connectionId: z.string().uuid(), parentId: z.string().max(200).nullable() }).strict(),
}).strict();
export const POST = route(async ({ req, ctx }) => ch.exportContentPlan(ctx, { ...(await parseJson(req, body)), idempotency_key: req.headers.get('idempotency-key') ?? undefined }));
