// GET /api/search?q=&kinds=post,campaign&limit=&include_archived= — authorized global search (command menu).
// Aborting the request (client cancels an obsolete query) cancels the SQL statement. Never cached.
import { z } from 'zod';
import { globalSearch, SearchCancelledError } from '@social-lite/services/data/search';
import { SEARCH_KINDS, type SearchKind } from '@social-lite/core/contracts/v31-data';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const q = z.object({
  q: z.string().max(200).default(''), kinds: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(20).optional(),
  include_archived: z.enum(['true', 'false']).optional(),
});

export const GET = route(async ({ req, ctx }) => {
  const p = q.parse(Object.fromEntries(req.nextUrl.searchParams));
  const kinds = p.kinds?.split(',').filter((k): k is SearchKind => (SEARCH_KINDS as string[]).includes(k));
  try {
    const r = await globalSearch(ctx, { q: p.q, kinds, limit: p.limit, include_archived: p.include_archived === 'true' }, req.signal);
    return Response.json(r, { headers: { 'cache-control': 'private, no-store' } });
  } catch (err) {
    if (err instanceof SearchCancelledError) return new Response(null, { status: 499 });
    throw err;
  }
});
