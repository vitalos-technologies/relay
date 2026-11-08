// GET /api/platform/entitlements/:workspaceId — plan, features, usage, held work, override history (support+, metadata
// only) · POST { kind, key, enabled|limit, reason, expires_at? } — apply an override (operator/billing staff, step-up;
// platform + workspace audit).
import { z } from 'zod';
import { applyOverride, platformEntitlements } from '@social-lite/services/entitlements/overrides';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute<{ workspaceId: string }>(async ({ p, params }) => platformEntitlements(p, params.workspaceId));
export const POST = platformRoute<{ workspaceId: string }>(async ({ req, p, params }) => applyOverride(p, params.workspaceId, await parseJson(req, z.unknown())));
