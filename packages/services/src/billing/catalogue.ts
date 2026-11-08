// Persisted catalogue (billing_plan_versions + billing_provider_prices). Versions are immutable; a subscription stays on
// the version it was bought at. The catalogue file (core/contracts/v4-plans.ts) is the source for NEW versions.
import { AppError, notFound } from '@social-lite/core';
import { PUBLIC_PLAN_IDS, type PlanId } from '@social-lite/core/contracts/v4-plans';
import { getPool, many, maybeOne, one, type Queryable } from '@social-lite/db';
import { catalogueHash, planVersionDefinition } from './catalogue-def.js';

export interface PlanVersionRow {
  id: string; plan_id: PlanId; version: number; name: string; summary: string; unit_amount_minor: number | null; currency: string; interval: string;
  per_seat: boolean; trial_days: number; features: string[]; allowances: Record<string, unknown>; trial_allowances: Record<string, unknown>;
  highlights: string[]; purchasable: boolean; catalogue_hash: string; created_at: Date; retired_at: Date | null;
}

export async function currentVersion(db: Queryable, planId: PlanId): Promise<PlanVersionRow> {
  const r = await maybeOne<PlanVersionRow>(db, `SELECT * FROM billing_plan_versions WHERE plan_id=$1 AND retired_at IS NULL`, [planId]);
  if (!r) throw notFound('Plan');
  return r;
}

export async function versionById(db: Queryable, id: string): Promise<PlanVersionRow | null> {
  return maybeOne<PlanVersionRow>(db, `SELECT * FROM billing_plan_versions WHERE id=$1`, [id]);
}

/** Provider price id for a version (current mapping). Missing mapping = billing not configured for that plan. */
export async function priceRefFor(db: Queryable, provider: 'stripe' | 'test', livemode: boolean, versionId: string): Promise<string> {
  const r = await maybeOne<{ price_ref: string }>(db,
    `SELECT price_ref FROM billing_provider_prices WHERE provider=$1 AND livemode=$2 AND plan_version_id=$3 AND retired_at IS NULL`, [provider, livemode, versionId]);
  if (!r) throw new AppError('provider_not_configured', 'This plan has no provider price yet. Relay staff must map it in Platform → Plans.', undefined, { missing: ['provider price'] });
  return r.price_ref;
}

/** Which plan version a provider price belongs to (any mapping ever made, so old subscriptions resolve too). */
export async function versionByPriceRef(db: Queryable, provider: 'stripe' | 'test', priceRef: string): Promise<PlanVersionRow | null> {
  return maybeOne<PlanVersionRow>(db,
    `SELECT v.* FROM billing_provider_prices p JOIN billing_plan_versions v ON v.id=p.plan_version_id WHERE p.provider=$1 AND p.price_ref=$2`, [provider, priceRef]);
}

export interface CatalogueVersionDto {
  id: string; version: number; name: string; unit_amount_minor: number | null; currency: string; interval: string; trial_days: number;
  features: string[]; allowances: Record<string, unknown>; trial_allowances: Record<string, unknown>; purchasable: boolean; created_at: string; retired_at: string | null;
  prices: Array<{ id: string; provider: string; livemode: boolean; price_ref: string; product_ref: string | null; retired_at: string | null }>;
  subscriptions: number;
}
export interface CataloguePlanDto { id: PlanId; public: boolean; current_version_id: string | null; drift: boolean; versions: CatalogueVersionDto[] }

export async function listCatalogue(db: Queryable = getPool()): Promise<CataloguePlanDto[]> {
  const plans = await many<{ id: PlanId; public: boolean }>(db, `SELECT id, public FROM billing_plans ORDER BY sort, id`);
  const versions = await many<PlanVersionRow & { subs: number }>(db,
    `SELECT v.*, (SELECT count(*)::int FROM workspace_billing b WHERE b.plan_version_id=v.id) subs FROM billing_plan_versions v ORDER BY v.plan_id, v.version DESC`);
  const prices = await many<{ id: string; plan_version_id: string; provider: string; livemode: boolean; price_ref: string; product_ref: string | null; retired_at: Date | null }>(db,
    `SELECT id, plan_version_id, provider, livemode, price_ref, product_ref, retired_at FROM billing_provider_prices ORDER BY created_at`);
  return plans.map((p) => {
    const vs = versions.filter((v) => v.plan_id === p.id);
    const current = vs.find((v) => !v.retired_at) ?? null;
    return {
      id: p.id, public: p.public, current_version_id: current?.id ?? null,
      drift: !!current && current.catalogue_hash !== catalogueHash(planVersionDefinition(p.id)),
      versions: vs.map((v) => ({
        id: v.id, version: v.version, name: v.name, unit_amount_minor: v.unit_amount_minor, currency: v.currency, interval: v.interval, trial_days: v.trial_days,
        features: v.features, allowances: v.allowances, trial_allowances: v.trial_allowances, purchasable: v.purchasable,
        created_at: v.created_at.toISOString(), retired_at: v.retired_at?.toISOString() ?? null, subscriptions: v.subs,
        prices: prices.filter((x) => x.plan_version_id === v.id).map((x) => ({ ...x, retired_at: x.retired_at?.toISOString() ?? null, plan_version_id: undefined })) as CatalogueVersionDto['prices'],
      })),
    };
  });
}

/** Publish the catalogue file's definition as a new immutable version (retires the previous one for NEW purchases only). */
export async function publishVersionTx(tx: Queryable, planId: PlanId, userId: string): Promise<PlanVersionRow> {
  const def = planVersionDefinition(planId);
  const hash = catalogueHash(def);
  const cur = await maybeOne<PlanVersionRow>(tx, `SELECT * FROM billing_plan_versions WHERE plan_id=$1 AND retired_at IS NULL FOR UPDATE`, [planId]);
  if (cur && cur.catalogue_hash === hash) throw new AppError('invalid_state', 'The persisted version already matches the catalogue.');
  const nextVersion = (await one<{ v: number }>(tx, `SELECT coalesce(max(version),0)+1 v FROM billing_plan_versions WHERE plan_id=$1`, [planId])).v;
  if (cur) await tx.query(`UPDATE billing_plan_versions SET retired_at=now() WHERE id=$1`, [cur.id]);
  const v = await one<PlanVersionRow>(tx,
    `INSERT INTO billing_plan_versions(plan_id, version, name, summary, unit_amount_minor, currency, interval, per_seat, trial_days, features, allowances, trial_allowances, highlights, purchasable, catalogue_hash, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [planId, nextVersion, def.name, def.summary, def.unit_amount_minor, def.currency, def.interval, def.per_seat, def.trial_days, JSON.stringify(def.features),
      JSON.stringify(def.allowances), JSON.stringify(def.trial_allowances), JSON.stringify(def.highlights), def.purchasable, hash, userId]);
  // The test double gets its own price automatically; Stripe prices are mapped by staff (activation item).
  if (v.purchasable) {
    await tx.query(`INSERT INTO billing_provider_prices(plan_version_id, provider, livemode, price_ref, product_ref, created_by) VALUES ($1,'test',false,$2,$3,$4)`,
      [v.id, `price_test_${v.plan_id}_v${v.version}`, `prod_test_${v.plan_id}`, userId]);
  }
  return v;
}

export function isPublicPlan(id: string): id is (typeof PUBLIC_PLAN_IDS)[number] {
  return (PUBLIC_PLAN_IDS as readonly string[]).includes(id);
}
