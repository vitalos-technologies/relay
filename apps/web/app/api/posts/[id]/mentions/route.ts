// GET /api/posts/:id/mentions?visibility=internal|shared&q= — bounded search of people who can see this discussion.
import { mentionCandidates } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => mentionCandidates(ctx, params.id,
  req.nextUrl.searchParams.get('visibility') === 'shared' ? 'shared' : 'internal', req.nextUrl.searchParams.get('q') ?? ''));
