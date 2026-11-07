// PUT /api/content-hub/settings { snapshot_retention_days } · POST adopts the latest Notion webhook verification token (owner).
import { z } from 'zod';
import * as ch from '@social-lite/services/content-hub/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ snapshot_retention_days: z.number().int() }).strict();
export const PUT = route(async ({ req, ctx }) => ch.setRetentionDays(ctx, (await parseJson(req, body)).snapshot_retention_days));
export const POST = route(async ({ ctx }) => ch.adoptNotionVerificationToken(ctx));
