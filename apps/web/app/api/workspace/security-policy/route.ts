// GET /api/workspace/security-policy (owner): two-step requirement, step-up window, guest/invitation expiry.
// PUT (owner, verified MFA; weakening also needs a fresh verification → 401 step_up_required). Audited, bumps policy version.
import { z } from 'zod';
import { getSecurityPolicy, updateSecurityPolicy } from '@social-lite/services/security-policy';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => getSecurityPolicy(ctx));
export const PUT = route(async ({ req, ctx }) => updateSecurityPolicy(ctx, await parseJson(req, z.unknown())));
