// DELETE /api/service-accounts/:id/keys/:keyId — revoke immediately.
import { revokeKey } from '@social-lite/services/service-accounts';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string; keyId: string }>(async ({ params, ctx }) => revokeKey(ctx, params.id, params.keyId));
