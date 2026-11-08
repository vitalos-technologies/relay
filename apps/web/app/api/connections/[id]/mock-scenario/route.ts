// PATCH /api/connections/:id/mock-scenario { scenario } — simulated destinations only.
import { mockScenarioSchema, setMockScenario } from '@social-lite/services/connections/index';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => setMockScenario(ctx, params.id, await parseJson(req, mockScenarioSchema)));
