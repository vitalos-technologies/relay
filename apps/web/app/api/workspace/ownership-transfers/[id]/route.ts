// DELETE /api/workspace/ownership-transfers/:id — cancel (proposer) or decline (proposed owner).
import { cancelOwnershipTransfer } from '@social-lite/services/lifecycle';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ ctx, params }) => cancelOwnershipTransfer(ctx, params.id));
