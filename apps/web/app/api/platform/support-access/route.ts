// GET/POST /api/platform/support-access — my requests; request { workspace_id, reason, ticket_ref?, duration_minutes }.
import { z } from 'zod';
import { myOperatorSupportAccess, requestSupportAccess } from '@social-lite/services/admin/support-access';
import { parseJson, platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ p }) => myOperatorSupportAccess(p));
export const POST = platformRoute(async ({ req, p }) => requestSupportAccess(p, await parseJson(req, z.unknown())));
