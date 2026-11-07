// GET /api/workspace/limits (owner/admin): caps + current-period usage · PATCH (owner) { x_monthly_writes?, x_monthly_reads?, ai_monthly_tokens? } (null = no cap). Audited.
import { getWorkspaceLimits, updateWorkspaceLimits } from '@social-lite/services/integrations/index';
import { parseJson, route } from '@/lib/api';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => getWorkspaceLimits(ctx));
export const PATCH = route(async ({ req, ctx }) => updateWorkspaceLimits(ctx, await parseJson(req, z.unknown())));
