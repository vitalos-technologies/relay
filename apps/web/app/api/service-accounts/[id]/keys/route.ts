// POST /api/service-accounts/:id/keys { label?, expires_at? } — new key (step-up), shown ONCE.
import { issueKey } from '@social-lite/services/service-accounts';
import { parseJson, route } from '@/lib/api';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, params, ctx }) =>
  Response.json(await issueKey(ctx, params.id, await parseJson(req, z.unknown())), { status: 201, headers: { 'cache-control': 'no-store' } }));
