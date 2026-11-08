// Canonical persisted form of a plan definition (core/contracts/v4-plans.ts → billing_plan_versions). The hash detects
// drift between the catalogue file and the latest persisted version (Platform → Plans offers "Publish version").
// Pure: no IO. Shared by the migration seed generator, the catalogue service and the drift test.
import { createHash } from 'node:crypto';
import { PLANS, type PlanDefinition, type PlanId } from '@social-lite/core/contracts/v4-plans';
import { stableStringify } from '../idempotency.js';

export interface PlanVersionDefinition {
  plan_id: PlanId;
  name: string;
  summary: string;
  unit_amount_minor: number | null;
  currency: string;
  interval: string;
  per_seat: boolean;
  trial_days: number;
  features: string[];
  allowances: PlanDefinition['allowances'];
  trial_allowances: PlanDefinition['trial_allowances'];
  highlights: string[];
  purchasable: boolean;
}

export function planVersionDefinition(id: PlanId): PlanVersionDefinition {
  const p = PLANS[id];
  return {
    plan_id: p.id, name: p.name, summary: p.summary, unit_amount_minor: p.unit_amount_minor, currency: p.currency, interval: p.interval,
    per_seat: p.per_seat, trial_days: p.trial_days, features: [...p.features], allowances: p.allowances, trial_allowances: p.trial_allowances,
    highlights: [...p.highlights], purchasable: p.public && p.unit_amount_minor != null,
  };
}

export function catalogueHash(def: PlanVersionDefinition): string {
  return createHash('sha256').update(stableStringify(def)).digest('hex');
}
