// GET /api/admin/changes — per-topic change markers (V3.1 Admin §5). No record data; workspace.read.
import { NextResponse } from 'next/server';
import { adminChanges } from '@social-lite/services/admin/changes';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => NextResponse.json(await adminChanges(ctx), { headers: { 'cache-control': 'no-store' } }));
