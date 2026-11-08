// GET /api/members/:userId · PATCH { role?, brand_ids? } (legacy "set role", translated to scoped grants)
// DELETE { reassign_to?, reason? } → removal (handover optional). Owners change only via ownership transfer.
import { z } from 'zod';
import { ROLES } from '@social-lite/core';
import { getMember, updateMember } from '@social-lite/services/members';
import { removeMember } from '@social-lite/services/lifecycle';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const patch = z.object({ role: z.enum(ROLES).optional(), brand_ids: z.array(z.string().max(64)).max(200).nullable().optional() }).strict();
const del = z.object({ reassign_to: z.string().max(64).nullable().optional(), reason: z.string().max(300).nullable().optional() }).strict();

export const GET = route<{ userId: string }>(async ({ ctx, params }) => getMember(ctx, params.userId));
export const PATCH = route<{ userId: string }>(async ({ req, ctx, params }) => updateMember(ctx, params.userId, await parseJson(req, patch)));
export const DELETE = route<{ userId: string }>(async ({ req, ctx, params }) => removeMember(ctx, params.userId, await parseJson(req, del)));
