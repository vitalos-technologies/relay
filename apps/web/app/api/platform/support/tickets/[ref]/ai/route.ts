// V4 Platform → Support — GET /api/platform/support/tickets/:ref/ai (recent drafts); POST { task }: summarize | draft_reply |
// suggest_category | related. Drafts only — nothing is sent or changed.
import { z } from 'zod';
import { listSupportAssist, runSupportAssist } from '@social-lite/services/support/ai';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute<{ ref: string }>(async ({ p, params }) => listSupportAssist(p, params.ref));
export const POST = platformRoute<{ ref: string }>(async ({ req, p, params }) => runSupportAssist(p, params.ref, await parseJson(req, z.unknown())));
