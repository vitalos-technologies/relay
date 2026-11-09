// GET /api/help/search?q=&limit= — Help Centre search (HC). Works signed out (public articles only); signed-in readers
// get what their audiences allow, resolved on the server from the session. Never returns article bodies.
import { NextResponse } from 'next/server';
import { helpLibrary, searchHelp } from '@social-lite/services/help/library';
import { publicRoute } from '@/lib/api';
import { getHelpViewer } from '@/lib/help-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute(async ({ req }) => {
  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 120);
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get('limit')) || 8, 1), 20);
  const viewer = await getHelpViewer();
  const results = searchHelp(helpLibrary(), viewer.audiences, q, limit)
    .map(({ slug, title, summary, href, section, sectionTitle, snippet }) => ({ slug, title, summary, href, section, sectionTitle, snippet }));
  return NextResponse.json({ results }, { headers: { 'cache-control': 'private, no-store', vary: 'cookie' } });
});
