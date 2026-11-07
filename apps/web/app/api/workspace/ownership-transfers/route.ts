// GET /api/workspace/ownership-transfers — pending transfers involving me (or all, for owners)
// POST { to_user_id, keep_previous_owner_as? } — owner proposes (fresh authentication required).
import { z } from 'zod';
import { listOwnershipTransfers, proposeOwnershipTransfer } from '@social-lite/services/lifecycle';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ to_user_id: z.string().max(64), keep_previous_owner_as: z.enum(['admin', 'none']).optional() }).strict();

export const GET = route(async ({ ctx }) => listOwnershipTransfers(ctx));
export const POST = route(async ({ req, ctx }) => proposeOwnershipTransfer(ctx, await parseJson(req, body)));
