// PATCH /api/platform/flags/:key { rollout_percent?, killed?, default_enabled?, reason } — operator, fresh.
import { z } from 'zod';
import { updatePlatformFlag } from '@social-lite/services/admin/platform';
import { parseJson, platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PATCH = platformRoute<{ key: string }>(async ({ req, p, params }) => updatePlatformFlag(p, params.key, await parseJson(req, z.unknown())));
