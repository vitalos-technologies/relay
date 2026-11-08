// POST /api/service-accounts/:id/disable — every key stops working immediately; grants revoked.
import { disableServiceAccount } from '@social-lite/services/service-accounts';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ params, ctx }) => disableServiceAccount(ctx, params.id));
