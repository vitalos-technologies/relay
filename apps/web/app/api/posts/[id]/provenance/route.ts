// V3.1 §13 — GET /api/posts/:id/provenance — { derived_from, derivatives[] }.
import { getProvenance } from '@social-lite/services/gov/reuse';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getProvenance(ctx, params.id));
