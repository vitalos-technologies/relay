// GET /api/ready (public) — { status, checks: { database, migrations } }; 503 when not ready.
import { NextResponse } from 'next/server';
import { readiness } from '@social-lite/services/diagnostics';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute(async () => {
  const r = await readiness();
  return NextResponse.json(r, { status: r.status === 'ready' ? 200 : 503, headers: { 'cache-control': 'no-store' } });
});
