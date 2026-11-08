// V4 billing API shapes (BIL). Types only. Customer: Settings → Billing (/api/billing/*). Staff: Platform billing
// (/api/platform/billing/*). Amounts are minor units (pence); dates ISO strings.
import type { BillingState } from './v4-billing.js';
import type { PlanCatalogueEntry, PlanId } from './v4-plans.js';

export interface BillingSeatsDto {
  /** Seat quantity on the subscription (or trial). */
  paid: number;
  billable: number;
  members: number;
  free_guests: number;
  billable_guests: number;
  pending_member_invites: number;
  support_operators: number;
}

export interface BillingInvoiceDto {
  id: string; number: string | null; status: string; currency: string; amount_due_minor: number; amount_paid_minor: number; total_minor: number;
  hosted_url: string | null; pdf_url: string | null; period_start: string | null; period_end: string | null; created_at: string; test_mode: boolean;
}

export interface BillingActionsDto {
  start_trial: boolean;
  change_trial_plan: boolean;
  checkout: boolean;
  change_subscription: boolean;
  cancel: boolean;
  reactivate: boolean;
  portal: boolean;
}

export interface BillingOverviewDto {
  state: BillingState;
  provider: { name: 'stripe' | 'test' | null; configured: boolean; test_mode: boolean };
  plan: { id: PlanId; name: string; unit_amount_minor: number | null; currency: string; interval: string; version: number | null } | null;
  trial: { started_at: string; ends_at: string; plan_id: PlanId; days_left: number; redeemed: boolean } | null;
  trial_used: boolean;
  seats: BillingSeatsDto;
  recurring_total_minor: number | null;
  /** Next renewal (active) or first charge (subscribed during the trial = trial end). */
  next_charge_at: string | null;
  first_charge_at: string | null;
  payment_method: { brand: string; last4: string; exp_month: number | null; exp_year: number | null } | null;
  scheduled_change: { plan_id: PlanId | null; plan_name: string | null; seats: number | null; effective_at: string } | null;
  open_checkout: { url: string; expires_at: string } | null;
  catalogue: PlanCatalogueEntry[];
  invoices: BillingInvoiceDto[];
  can_manage: boolean;
  actions: BillingActionsDto;
  last_synced_at: string | null;
  /** Optimistic-concurrency token for /api/billing/change (expected_version). */
  version: number;
}

export interface BillingChangePreviewDto {
  kind: 'immediate' | 'scheduled' | 'trial' | 'none';
  from: { plan_id: PlanId; seats: number; recurring_minor: number | null };
  to: { plan_id: PlanId; seats: number; recurring_minor: number };
  /** Charged (or credited, negative) on the next invoice for the rest of this period. Provider-computed. */
  proration_minor: number;
  next_invoice_minor: number | null;
  next_invoice_at: string | null;
  effective_at: string;
  proration_date: number | null;
  currency: string;
  lines: Array<{ description: string; amount_minor: number; proration: boolean }>;
  notes: string[];
}

export interface PlatformBillingDetailDto {
  workspace_id: string;
  state: BillingState;
  plan_name: string | null;
  plan_version: number | null;
  seats: BillingSeatsDto;
  provider: { name: 'stripe' | 'test' | null; livemode: boolean | null; customer_ref: string | null; subscription_ref: string | null; provider_status: string | null;
    customer_url: string | null; subscription_url: string | null; synced_at: string | null };
  trial: { started_at: string; ends_at: string; original_ends_at: string; extensions: number; redeemed_by: string | null; source: string; eligible_for_extension: boolean } | null;
  payment_issue: { since: string | null; grace_ends_at: string | null; action_required: boolean } | null;
  invoices: Array<BillingInvoiceDto & { provider_url: string | null }>;
  lifecycle: Array<{ id: string; at: string; kind: string; from_status: string | null; to_status: string | null; from_plan: string | null; to_plan: string | null; seats: number | null; source: string; actor: string | null; reason: string | null }>;
  webhook_failures: Array<{ id: string; type: string; attempts: number; last_error: string | null; received_at: string }>;
  scheduled_actions: Array<{ id: string; action: string; run_at: string; reason: string; status: string; created_by: string | null }>;
  duplicate_subscriptions: string[];
  can_act: boolean;
}

export interface PlatformBillingListItem {
  workspace_id: string; name: string; plan_id: PlanId | null; status: BillingState['status']; access: BillingState['access']; seats: number;
  trial_ends_at: string | null; current_period_end: string | null; grace_ends_at: string | null; cancel_at: string | null; updated_at: string | null;
}
