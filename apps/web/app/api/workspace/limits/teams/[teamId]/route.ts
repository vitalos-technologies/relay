// PATCH /api/workspace/limits/teams/:teamId { "ai.tokens"?, "x.write"?, "x.read"?, "storage.bytes"?, "exports.count"? }
// (null = no team cap). Owner only (security.manage); audited. Returns the Budgets view.
import { z } from 'zod';
import { updateTeamBudgets } from '@social-lite/services/product/usage-admin';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PATCH = route<{ teamId: string }>(async ({ req, ctx, params }) => updateTeamBudgets(ctx, params.teamId, await parseJson(req, z.unknown())));
