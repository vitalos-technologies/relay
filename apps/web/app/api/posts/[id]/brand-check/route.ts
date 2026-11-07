// V3.1 §12 — POST /api/posts/:id/brand-check { connection_ids?, at? } — read-only brand rule evaluation for the composer
// ({ ok, mandatory[], advisory[] }). Mandatory findings are also enforced by submit/schedule/publish.
import { z } from 'zod';
import { checkPostBrandRules } from '@social-lite/services/gov/brand-rules';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => checkPostBrandRules(ctx, params.id, await parseJson(req, z.unknown())));
