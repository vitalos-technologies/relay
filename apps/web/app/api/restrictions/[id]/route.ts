// DELETE /api/restrictions/:id — lift an explicit restriction (never auto-releases held publications).
import { revokeRestriction } from '@social-lite/services/members';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => revokeRestriction(ctx, params.id));
