// GET /api/brands/:id · PATCH /api/brands/:id (owner/admin)
import { z } from 'zod';
import { brandVoiceSchema, getBrand, updateBrand } from '@social-lite/services/brands';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const patch = z.object({
  name: z.string().max(200).optional(),
  timezone: z.string().max(64).optional(),
  approval_required: z.boolean().optional(),
  editors_can_publish: z.boolean().optional(),
  default_deadline_minutes: z.number().int().min(1).max(10080).optional(),
  voice: brandVoiceSchema.optional(),
}).strict();

export const GET = route<{ id: string }>(async ({ ctx, params }) => getBrand(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateBrand(ctx, params.id, await parseJson(req, patch)));
