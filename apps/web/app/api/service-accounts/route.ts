// GET /api/service-accounts — owner/admin list (keys by prefix only) · POST create (step-up) → first key shown ONCE.
import { createServiceAccount, listServiceAccounts } from '@social-lite/services/service-accounts';
import { idempotencyKey, parseJson, route } from '@/lib/api';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listServiceAccounts(ctx));
export const POST = route(async ({ req, ctx }) => {
  const res = await createServiceAccount(ctx, await parseJson(req, z.unknown()), idempotencyKey(req));
  return Response.json(res, { status: 201, headers: { 'cache-control': 'no-store' } });
});
