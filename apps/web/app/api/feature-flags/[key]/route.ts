// V3.1 §16 — PUT /api/feature-flags/:key { enabled: true|false|null } — workspace override (workspace.manage, audited).
import { z } from 'zod';
import { setWorkspaceFlag } from '@social-lite/services/gov/release';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PUT = route<{ key: string }>(async ({ req, ctx, params }) => setWorkspaceFlag(ctx, params.key, await parseJson(req, z.unknown())));
