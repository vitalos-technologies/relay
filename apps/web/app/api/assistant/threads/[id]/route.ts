// GET /api/assistant/threads/:id (runs, oldest first) · PATCH {title?, archived?}
import { z } from 'zod';
import { getThread, updateThread } from '@social-lite/services/ai-workflows/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getThread(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateThread(ctx, params.id, await parseJson(req, z.unknown())));
