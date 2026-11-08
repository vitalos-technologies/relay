// POST /api/posts/:id/versions/:versionId/restore — restore as the working draft (optimistic concurrency).
import { z } from 'zod';
import { restoreVersion } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ expected_version: z.number().int().min(1) }).strict();
export const POST = route<{ id: string; versionId: string }>(async ({ req, ctx, params }) => restoreVersion(ctx, params.id, params.versionId, (await parseJson(req, body)).expected_version));
