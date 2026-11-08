// V5 Platform → Marketing configuration (brief §16 "Marketing configuration"; stream MKT). Small, installation-wide, no
// secrets: support-widget switches (read by stream WID), legal link targets and a public support address. Stored in
// `system_flags` (key 'marketing_config', JSON) — no migration. Read server-side only (marketing page, widget service);
// there is deliberately NO public settings API. Changes: platform operators with a fresh MFA sign-in, reason required,
// audited in platform_audit_events with a before/after diff.
import { z } from 'zod';
import { DEFAULT_MARKETING_CONFIG, MARKETING_CONFIG_KEY, type MarketingConfig } from '@social-lite/core/contracts/v5-marketing';
import { getPool, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { platformAudit, requireFresh, requirePlatform, type PlatformCtx } from '../admin/platform.js';

type Stored = Omit<MarketingConfig, 'updated_at' | 'updated_by'>;
const FIELDS = ['widget_enabled', 'widget_staffed', 'widget_in_app', 'privacy_url', 'terms_url', 'support_email'] as const;

/** Same-site path (`/legal/privacy`) or an https URL. Anything else (javascript:, data:, http:, protocol-relative) is refused. */
const linkSchema = z.string().trim().max(500).refine((v) => {
  if (v.startsWith('/')) return !v.startsWith('//') && !v.startsWith('/\\') && !/[\s\\]/.test(v);
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}, 'Use a path on this site (/…) or an https:// address').nullable();

export const marketingConfigPatch = z.object({
  widget_enabled: z.boolean().optional(),
  widget_staffed: z.boolean().optional(),
  widget_in_app: z.boolean().optional(),
  privacy_url: linkSchema.optional(),
  terms_url: linkSchema.optional(),
  support_email: z.string().trim().max(254).email('Enter an email address').nullable().optional(),
  reason: z.string().trim().min(10, 'Give a reason (10+ characters)').max(500),
}).strict();

function normalise(raw: unknown): Stored {
  const out: Stored = { ...DEFAULT_MARKETING_CONFIG };
  delete (out as Partial<MarketingConfig>).updated_at;
  delete (out as Partial<MarketingConfig>).updated_by;
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of ['widget_enabled', 'widget_staffed', 'widget_in_app'] as const) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  // Re-validate stored links on read: a bad row can never put an unsafe href on the public page.
  for (const k of ['privacy_url', 'terms_url'] as const) { const p = linkSchema.safeParse(r[k] ?? null); if (p.success) out[k] = p.data; }
  const e = z.string().email().max(254).safeParse(r.support_email);
  if (e.success) out.support_email = e.data;
  // Staffed availability only means something while the widget is on.
  if (!out.widget_enabled) out.widget_staffed = false;
  return out;
}

/**
 * The current marketing configuration (defaults when unset: widget off, not staffed → "Send us a message"). Safe to call
 * on the public page request path (one indexed read; no provider or network calls).
 */
export async function marketingConfig(db: Queryable = getPool()): Promise<MarketingConfig> {
  const row = await maybeOne<{ value: unknown; updated_at: Date; updated_by: string | null }>(db,
    `SELECT value, updated_at, updated_by FROM system_flags WHERE key=$1`, [MARKETING_CONFIG_KEY]);
  if (!row) return { ...DEFAULT_MARKETING_CONFIG };
  return { ...normalise(row.value), updated_at: row.updated_at.toISOString(), updated_by: row.updated_by };
}

/** Platform → Marketing read (any platform role: support, billing, operator). */
export async function platformMarketingConfig(p: PlatformCtx, db: Queryable = getPool()): Promise<MarketingConfig> {
  requirePlatform(p, 'staff');
  return marketingConfig(db);
}

/** Operators only, fresh MFA sign-in, reason required; audited with a before/after diff. */
export async function updateMarketingConfig(p: PlatformCtx, raw: unknown): Promise<MarketingConfig> {
  requirePlatform(p, 'operator');
  requireFresh(p);
  const patch = marketingConfigPatch.parse(raw);
  return withTx(async (tx) => {
    const cur = await maybeOne<{ value: unknown }>(tx, `SELECT value FROM system_flags WHERE key=$1 FOR UPDATE`, [MARKETING_CONFIG_KEY]);
    const before = normalise(cur?.value);
    const after: Stored = { ...before };
    for (const k of FIELDS) if (patch[k] !== undefined) (after as Record<string, unknown>)[k] = patch[k];
    if (!after.widget_enabled) after.widget_staffed = false;
    await tx.query(`INSERT INTO system_flags(key, value, updated_by) VALUES ($1, $2::jsonb, $3)
                    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [MARKETING_CONFIG_KEY, JSON.stringify(after), `operator:${p.actor.userId}`]);
    const changed = FIELDS.filter((k) => before[k] !== after[k]);
    await platformAudit(tx, p, {
      action: 'marketing.config_updated', targetType: 'installation', targetId: MARKETING_CONFIG_KEY, reason: patch.reason,
      diff: { changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])) },
    });
    return marketingConfig(tx);
  });
}
