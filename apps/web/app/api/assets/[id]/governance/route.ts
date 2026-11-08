// V3.1 §12 — GET/PATCH /api/assets/:id/governance — ownership, licence notes, expiry, superseded/archived lifecycle.
import { z } from 'zod';
import { getAssetGovernance, setAssetGovernance } from '@social-lite/services/gov/assets';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getAssetGovernance(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => setAssetGovernance(ctx, params.id, await parseJson(req, z.unknown())));
