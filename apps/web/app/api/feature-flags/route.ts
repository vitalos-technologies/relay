// V3.1 §16 — GET /api/feature-flags — effective flags for the active workspace (safe default: off).
import { NextResponse } from 'next/server';
import { listFeatureFlags } from '@social-lite/services/gov/release';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => NextResponse.json(await listFeatureFlags(ctx), { headers: { 'cache-control': 'no-store' } }));
