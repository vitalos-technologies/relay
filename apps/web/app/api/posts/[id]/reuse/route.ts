// V3.1 §13 — POST /api/posts/:id/reuse { mode: reuse|duplicate, title? } — new draft with provenance, eligibility and
// similar-post warnings per destination. TipSignal picks/results are refused (never recycled).
import { z } from 'zod';
import { reusePost } from '@social-lite/services/gov/reuse';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => reusePost(ctx, params.id, await parseJson(req, z.unknown())));
