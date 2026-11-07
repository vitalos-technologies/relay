// POST /api/platform/accounts/:id/suspend { reason } — blocks sign-in, ends sessions; memberships unchanged.
import { z } from 'zod';
import { setAccountDisabled } from '@social-lite/services/admin/platform';
import { parseJson, platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ id: string }>(async ({ req, p, params }) => setAccountDisabled(p, params.id, await parseJson(req, z.unknown()), true));
