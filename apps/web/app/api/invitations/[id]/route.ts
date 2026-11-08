// DELETE /api/invitations/:id — revoke.
import { revokeInvitation } from '@social-lite/services/auth/invitations';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => {
  await revokeInvitation(ctx, params.id);
  return { ok: true };
});
