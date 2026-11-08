// GET /api/bulk/jobs — my recent bulk jobs · POST — start a previewed bulk job (Idempotency-Key + preview_hash).
import { z } from 'zod';
import { listBulkJobs, startBulk } from '@social-lite/services/data/bulk';
import type { BulkStartRequest } from '@social-lite/core/contracts/v31-data';
import { idempotencyKey, parseJson, route } from '@/lib/api';
import { bulkRequest } from '../schema';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const start = bulkRequest.extend({ preview_hash: z.string().regex(/^[0-9a-f]{64}$/) });

export const GET = route(async ({ ctx }) => listBulkJobs(ctx));
export const POST = route(async ({ req, ctx }) => Response.json(await startBulk(ctx, (await parseJson(req, start)) as BulkStartRequest, idempotencyKey(req)), { status: 202 }));
