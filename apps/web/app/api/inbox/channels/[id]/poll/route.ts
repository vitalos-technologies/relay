// POST /api/inbox/channels/:id/poll — "Check now" for a polling channel (inbox.manage). Stream B.
import { pollChannelNow } from '@social-lite/services/inbox/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => pollChannelNow(ctx, params.id));
