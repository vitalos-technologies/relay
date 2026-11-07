// GET/PATCH /api/brands/:id/duplicate-window { duplicate_window_hours: 0..720 } — duplicate/collision
// warning window for this brand (0 = off). PATCH needs brands.manage on the brand; audited.
import { z } from 'zod';
import { getDuplicateWindow, setDuplicateWindow } from '@social-lite/services/product/readiness';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getDuplicateWindow(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => setDuplicateWindow(ctx, params.id, await parseJson(req, z.unknown())));
