// GET /api/members/:userId/history — membership status history (active/suspended/removed transitions).
import { membershipHistory } from '@social-lite/services/lifecycle';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ userId: string }>(async ({ ctx, params }) => membershipHistory(ctx, params.userId));
