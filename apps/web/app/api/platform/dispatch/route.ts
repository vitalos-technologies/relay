// POST /api/platform/dispatch { enabled, reason } — installation-wide dispatch switch. operator, fresh.
import { z } from 'zod';
import { setGlobalDispatch } from '@social-lite/services/admin/platform';
import { parseJson, platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute(async ({ req, p }) => setGlobalDispatch(p, await parseJson(req, z.unknown())));
