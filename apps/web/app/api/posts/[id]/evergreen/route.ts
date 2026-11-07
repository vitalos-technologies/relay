// V3.1 §13 — GET /api/posts/:id/evergreen (eligibility) · PUT { evergreen, expires_at?, note? } (explicit marking).
import { z } from 'zod';
import { getReuseEligibility, setEvergreen } from '@social-lite/services/gov/reuse';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getReuseEligibility(ctx, params.id));
export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => setEvergreen(ctx, params.id, await parseJson(req, z.unknown())));
