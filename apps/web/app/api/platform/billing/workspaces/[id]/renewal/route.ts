// POST /api/platform/billing/workspaces/:id/renewal { cancel, reason } — cancel / resume renewal at the provider (billing staff, step-up).
// Billing only: the service is not suspended by this.
import { z } from 'zod';
import { staffSetRenewal } from '@social-lite/services/billing/platform';
import { parseJson, platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute<{ id: string }>(async ({ req, p, params }) => staffSetRenewal(p, params.id, await parseJson(req, z.unknown())));
