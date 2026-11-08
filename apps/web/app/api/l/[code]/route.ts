// V3.1 §14 — GET /api/l/:code — public short-link redirect. NOT an open redirect: the only input is an unguessable
// code; the target is the stored, validated destination. Unknown/disabled codes get a plain 404 (no redirect).
import { NextResponse } from 'next/server';
import { resolveTrackedLink } from '@social-lite/services/gov/links';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute<{ code: string }>(async ({ params }) => {
  const target = await resolveTrackedLink(params.code);
  if (!target) return NextResponse.json({ error: { code: 'not_found', message: 'Link not found' } }, { status: 404, headers: { 'cache-control': 'no-store' } });
  return new NextResponse(null, { status: 302, headers: { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
});
