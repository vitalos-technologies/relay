// GET post detail · PATCH autosave draft (expected_version)
import { z } from 'zod';
import { getPostDetail, updateDraft } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const patch = z.object({ expected_version: z.number().int().positive(), draft: z.unknown().optional(), title: z.string().max(200).nullable().optional(), tags: z.array(z.string().trim().min(1).max(40)).max(20).optional() });

export const GET = route<{ id: string }>(async ({ ctx, params }) => getPostDetail(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateDraft(ctx, params.id, await parseJson(req, patch)));
