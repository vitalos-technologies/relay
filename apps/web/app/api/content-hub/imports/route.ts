// POST /api/content-hub/imports — request an import (idempotent per source identity/version + brand + action + selection).
import { z } from 'zod';
import * as ch from '@social-lite/services/content-hub/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  source_item_id: z.string().uuid(), action: z.enum(['media_asset', 'doc_drafts', 'doc_campaign', 'notion_page_draft', 'notion_rows']),
  fingerprint: z.string().max(64).optional(), section_ids: z.array(z.string().max(300)).max(50).optional(), suggestions_mode: z.enum(['exclude', 'accept', 'inline']).optional(),
  combine: z.boolean().optional(), campaign_name: z.string().max(120).nullish(), connection_ids: z.array(z.string().uuid()).max(50).optional(),
  row_ids: z.array(z.string().max(64)).max(100).optional(), create_draft: z.boolean().optional(), copy_nonce: z.string().max(64).nullish(),
}).strict();
export const POST = route(async ({ req, ctx }) => ch.requestImport(ctx, await parseJson(req, body)));
