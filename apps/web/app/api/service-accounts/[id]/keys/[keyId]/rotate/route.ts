// POST /api/service-accounts/:id/keys/:keyId/rotate — replacement key (step-up, shown ONCE); old key revoked now.
import { rotateKey } from '@social-lite/services/service-accounts';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string; keyId: string }>(async ({ params, ctx }) =>
  Response.json(await rotateKey(ctx, params.id, params.keyId), { status: 201, headers: { 'cache-control': 'no-store' } }));
