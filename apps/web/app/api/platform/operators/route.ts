// GET/POST /api/platform/operators — list; grant { email, role, reason } (operator, fresh).
import { z } from 'zod';
import { grantOperator, listOperators } from '@social-lite/services/admin/platform';
import { parseJson, platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ p }) => listOperators(p));
export const POST = platformRoute(async ({ req, p }) => grantOperator(p, await parseJson(req, z.unknown())));
