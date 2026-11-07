// GET/PUT /api/brands/:id/approval-policy — 0/1/2 stages, quorum, eligible roles/teams/guests, separation of duties.
// Weakening requires brands.manage + fresh authentication (401 step_up_required); every change is audited.
import { z } from 'zod';
import { getApprovalPolicy, saveApprovalPolicy } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const stage = z.object({
  name: z.string().min(1).max(60),
  quorum: z.number().int().min(1).max(10),
  eligible_roles: z.array(z.enum(['owner', 'admin', 'approver'])).max(3),
  eligible_team_ids: z.array(z.string().uuid()).max(20),
  allow_guests: z.boolean(),
}).strict();
const body = z.object({
  expected_generation: z.number().int().min(0),
  separation_of_duties: z.boolean(),
  stages: z.array(stage).max(2),
  reason: z.string().max(500).optional(),
}).strict();

export const GET = route<{ id: string }>(async ({ ctx, params }) => getApprovalPolicy(ctx, params.id));
export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => saveApprovalPolicy(ctx, params.id, await parseJson(req, body)));
