// GET /api/listening/share-of-voice?search_ids=a,b&days= — within observed data, comparable sources only
import { shareOfVoice } from '@social-lite/services/listening/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => shareOfVoice(ctx, queryOf(req)));
