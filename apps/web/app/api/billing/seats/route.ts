// GET /api/billing/seats?add=1 — paid seats, billable users and the recurring total after adding seats (members.invite or billing.read).
import { AppError } from '@social-lite/core';
import { seatsPreview } from '@social-lite/services/billing/seats';
import { authorizeCtx } from '@social-lite/services';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  if (!authorizeCtx(ctx, 'billing.read').allowed && !authorizeCtx(ctx, 'members.invite').allowed) throw new AppError('forbidden', 'You do not have permission to do that');
  const add = Math.min(100, Math.max(0, Number(req.nextUrl.searchParams.get('add') ?? '0') || 0));
  return seatsPreview(ctx.access.workspaceId, add);
});
