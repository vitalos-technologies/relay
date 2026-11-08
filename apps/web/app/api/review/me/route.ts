// GET /api/review/me — { guest_only } so the main app can send guests to the review portal.
import { reviewMe } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => reviewMe(ctx));
