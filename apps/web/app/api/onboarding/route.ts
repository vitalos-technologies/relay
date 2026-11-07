// V3.1 §7 — GET /api/onboarding — resumable, role-adapted checklist + per-connection readiness.
// PATCH { dismissed?, acknowledge?, unacknowledge? } — the viewer's own choices only.
import { z } from 'zod';
import { onboardingState, updateOnboarding } from '@social-lite/services/gov/onboarding';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => onboardingState(ctx));
export const PATCH = route(async ({ req, ctx }) => updateOnboarding(ctx, await parseJson(req, z.unknown())));
