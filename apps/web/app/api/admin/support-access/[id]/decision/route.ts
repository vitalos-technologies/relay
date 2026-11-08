// POST /api/admin/support-access/:id/decision { decision: approve|decline, note? } — members.manage + fresh sign-in.
import { z } from 'zod';
import { decideSupportAccess } from '@social-lite/services/admin/support-access';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => decideSupportAccess(ctx, params.id, await parseJson(req, z.unknown())));
