// PUT /api/content-hub/items/:id/mapping { mapping, import_statuses, writeback, expected_version }
import { z } from 'zod';
import * as ch from '@social-lite/services/content-hub/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ids = z.string().min(1).max(200);
const body = z.object({
  mapping: z.object({ title: ids, body: ids, campaign: ids, target_date: ids, status: ids, external_ref: ids }).partial().strict(),
  import_statuses: z.array(z.string().max(100)).max(50).optional(),
  writeback: z.object({ status: ids, scheduled_time: ids, post_url: ids }).partial().strict().optional(),
  expected_version: z.number().int().nullish(),
}).strict();
export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => ch.saveMapping(ctx, params.id, await parseJson(req, body)));
