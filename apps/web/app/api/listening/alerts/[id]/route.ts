// GET /api/listening/alerts/:id — alert + evidence (the real mentions counted) + coverage · PATCH { state }
import { z } from 'zod';
import { getAlert, setAlertState } from '@social-lite/services/listening/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getAlert(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => setAlertState(ctx, params.id, (await parseJson(req, z.object({ state: z.enum(['open', 'acknowledged', 'dismissed']) }).strict())).state));
