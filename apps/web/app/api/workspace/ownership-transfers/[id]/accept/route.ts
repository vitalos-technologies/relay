// POST /api/workspace/ownership-transfers/:id/accept — the proposed owner accepts (fresh MFA session); atomic.
import { acceptOwnershipTransfer } from '@social-lite/services/lifecycle';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => acceptOwnershipTransfer(ctx, params.id));
