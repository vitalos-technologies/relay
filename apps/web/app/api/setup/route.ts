// GET /api/setup (owner) — grouped configuration readiness. Secrets are never returned.
import { NextResponse } from 'next/server';
import { getSetup } from '@social-lite/services/setup';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => NextResponse.json(await getSetup(ctx), { headers: { 'cache-control': 'no-store' } }));
