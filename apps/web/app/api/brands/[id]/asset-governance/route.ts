// V3.1 §12 — GET /api/brands/:id/asset-governance — assets needing attention (expired, expiring ≤14 d, superseded, archived).
import { listAssetGovernance } from '@social-lite/services/gov/assets';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => listAssetGovernance(ctx, params.id));
