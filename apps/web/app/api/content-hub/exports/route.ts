// POST /api/content-hub/exports — ReportExporter (new Doc / Drive file / Notion page). Destination + content checked independently.
import { z } from 'zod';
import * as ch from '@social-lite/services/content-hub/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  destination: z.object({ kind: z.enum(['google_doc', 'drive_file', 'notion_page']), connectionId: z.string().uuid(), parentId: z.string().max(200).nullable() }).strict(),
  title: z.string().min(1).max(200), format: z.enum(['html', 'markdown', 'csv', 'text']),
  html: z.string().max(5_000_000).optional(), text: z.string().max(5_000_000).optional(),
  content: z.object({ kind: z.enum(['analytics_report', 'content_plan', 'other']), brandId: z.string().uuid().nullable(), permission: z.enum(['analytics.read', 'content.read']), ref: z.string().max(200).nullish() }).strict(),
}).strict();
export const POST = route(async ({ req, ctx }) => ch.requestExport(ctx, { ...(await parseJson(req, body)), idempotencyKey: req.headers.get('idempotency-key') ?? undefined }));
