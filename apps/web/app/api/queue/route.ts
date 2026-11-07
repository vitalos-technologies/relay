// GET /api/queue?brand_id=&days= — upcoming slot occurrences (free / taken / DST-skipped).
// POST /api/queue 🔁 { post_id, expected_version, slot_id? } — "Add to queue": next free slot via the normal
// scheduling pipeline (submits for review when the brand requires approval). 202 { schedule, deliveries, approval?, queue }.
import { NextResponse } from 'next/server';
import { AppError } from '@social-lite/core';
import { queuePost, queueView } from '@social-lite/services/slots/index';
import { idempotencyKey, parseJson, route } from '@/lib/api';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const brandId = req.nextUrl.searchParams.get('brand_id');
  if (!brandId) throw new AppError('validation_failed', 'brand_id is required', { brand_id: 'Required' });
  return queueView(ctx, brandId, Number(req.nextUrl.searchParams.get('days') ?? 14) || 14);
});

export const POST = route(async ({ req, ctx }) => {
  const r = await queuePost(ctx, await parseJson(req, z.unknown()), idempotencyKey(req));
  return NextResponse.json(r.body, { status: r.status });
});
