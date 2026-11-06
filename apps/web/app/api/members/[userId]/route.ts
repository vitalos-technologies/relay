// PATCH /api/members/:userId { role?, brand_ids? } · DELETE /api/members/:userId → { ok, impact }
import { z } from 'zod';
import { ROLES } from '@social-lite/core';
import { removeMember, updateMember } from '@social-lite/services/members';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const patch = z.object({ role: z.enum(ROLES).optional(), brand_ids: z.array(z.string().max(64)).max(200).nullable().optional() }).strict();

export const PATCH = route<{ userId: string }>(async ({ req, ctx, params }) => updateMember(ctx, params.userId, await parseJson(req, patch)));
export const DELETE = route<{ userId: string }>(async ({ ctx, params }) => removeMember(ctx, params.userId));
