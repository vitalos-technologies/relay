// PATCH /api/slots/:id (owner/admin) — never moves posts already queued · DELETE /api/slots/:id (archive)
import { deleteSlot, updateSlot } from '@social-lite/services/slots/index';
import { parseJson, route } from '@/lib/api';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateSlot(ctx, params.id, await parseJson(req, z.unknown())));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => deleteSlot(ctx, params.id));
