// GET /api/diagnostics (owner/admin) — { checks: [{ name, ok, detail }] }
import { NextResponse } from 'next/server';
import { diagnostics } from '@social-lite/services/diagnostics';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => NextResponse.json(await diagnostics(ctx), { headers: { 'cache-control': 'no-store' } }));
