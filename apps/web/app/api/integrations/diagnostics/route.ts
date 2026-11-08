// V3.1 §15 — GET /api/integrations/diagnostics?brand_id=&connection_id= — read-only integration test centre.
// Never calls a provider, never publishes, never returns tokens.
import { NextResponse } from 'next/server';
import { integrationDiagnostics } from '@social-lite/services/gov/diagnostics';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => NextResponse.json(await integrationDiagnostics(ctx, {
  brand_id: req.nextUrl.searchParams.get('brand_id') || null, connection_id: req.nextUrl.searchParams.get('connection_id') || null,
}), { headers: { 'cache-control': 'no-store' } }));
