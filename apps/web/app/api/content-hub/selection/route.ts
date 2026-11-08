// POST /api/content-hub/selection — register Picker / Notion selections (server verifies each id with the saved authorization).
import { z } from 'zod';
import * as ch from '@social-lite/services/content-hub/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  connection_id: z.string().uuid(), brand_id: z.string().uuid(), purpose: z.enum(['import', 'export_destination']).optional(),
  items: z.array(z.object({ id: z.string().min(1).max(200), kind: z.enum(['drive', 'notion_page', 'notion_data_source']).optional() })).min(1).max(20),
}).strict();
export const POST = route(async ({ req, ctx }) => ch.registerSelection(ctx, await parseJson(req, body)));
