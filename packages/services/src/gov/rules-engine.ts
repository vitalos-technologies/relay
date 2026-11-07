// V3.1 §12 — pure brand-rule evaluation (no IO; unit-tested). Mandatory findings block submit/schedule/publish on
// the server; advisory findings only warn. The two are never merged: each finding carries its own severity, taken
// from the rule (explicit), or fixed for asset/TipSignal checks (expired asset = mandatory, superseded = advisory,
// any TipSignal fact deviation = mandatory).
import type { Provider } from '@social-lite/core';
import type { BrandFinding, BrandFindingCode, BrandRuleKind, RuleSeverity } from '@social-lite/core/contracts/v31-gov';
import { checkSuggestion, extractUrls, findProhibited } from '../ai/fidelity.js';

export interface RuleInput {
  id: string | null;
  kind: BrandRuleKind;
  value: string;
  replacement: string | null;
  severity: RuleSeverity;
  providers: string[];
  source: 'brand_rule' | 'brand_voice';
}

export interface VariantInput {
  connectionId: string | null;
  provider: Provider | null;
  text: string;
  link: string | null;
  assetIds: string[];
}

export interface AssetGovernanceFacts {
  id: string;
  name: string | null;
  expires_at: Date | null;
  lifecycle: 'active' | 'superseded' | 'archived';
  superseded_by: string | null;
}

/** Facts from the validated TipSignal event (the post's source). */
export interface TipsignalFacts {
  type: 'picks.ready' | 'results.settled';
  /** Deterministic source copy (draftText) whose facts must survive unchanged. */
  sourceText: string;
  /** Exact validated names/terms (teams, competition, market, selection, result verdict). */
  requiredPhrases: string[];
  kickoffAt: Date;
}

export interface EvaluateInput {
  rules: RuleInput[];
  variants: VariantInput[];
  assets: AssetGovernanceFacts[];
  tipsignal?: TipsignalFacts | null;
  /** Brand-approved text whose facts/links may be added (footers, disclaimers, CTA, hashtags). */
  allowedText?: string;
  /** Hosts always allowed (the app's own short-link host). */
  trustedHosts?: string[];
  /** Publish instant (asset expiry / pick expiry are checked against it). */
  at: Date;
  now?: Date;
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export function normaliseDomain(v: string): string | null {
  const s = v.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s) ? s : null;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

export function hostAllowed(host: string, domains: string[]): boolean {
  const h = host.replace(/^www\./, '');
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

const appliesTo = (r: RuleInput, provider: Provider | null) => !r.providers.length || (provider !== null && r.providers.includes(provider));

const TS_CODE: Record<string, BrandFindingCode | undefined> = {
  fact_altered: 'tipsignal_fact_altered', fact_dropped: 'tipsignal_fact_dropped', fact_invented: 'tipsignal_fact_invented',
  link_dropped: 'tipsignal_link', link_invented: 'tipsignal_link', promise_language: 'tipsignal_promise_language',
};

export function evaluateBrandRules(input: EvaluateInput): BrandFinding[] {
  const now = input.now ?? new Date();
  const raw: BrandFinding[] = [];
  const push = (f: Omit<BrandFinding, 'rule_id' | 'asset_id' | 'connection_id'> & Partial<Pick<BrandFinding, 'rule_id' | 'asset_id' | 'connection_id'>>) =>
    raw.push({ rule_id: null, asset_id: null, connection_id: null, ...f });
  const variants = input.variants.length ? input.variants : [];

  for (const v of variants) {
    const cid = v.connectionId;
    const text = v.text ?? '';
    const ntext = norm(text);
    const rules = input.rules.filter((r) => appliesTo(r, v.provider));
    for (const r of rules) {
      switch (r.kind) {
        case 'prohibited_phrase':
        case 'discouraged_phrase':
          if (findProhibited(text, [r.value]).length) {
            push({ code: r.kind, severity: r.severity, source: r.source, rule_id: r.id, connection_id: cid,
              message: r.kind === 'prohibited_phrase' ? `Uses the prohibited phrase “${r.value}”.` : `Avoid “${r.value}”.` });
          }
          break;
        case 'preferred_term':
          if (findProhibited(text, [r.value]).length) {
            push({ code: 'preferred_term', severity: r.severity, source: r.source, rule_id: r.id, connection_id: cid,
              message: r.replacement ? `Use “${r.replacement}” instead of “${r.value}”.` : `Avoid “${r.value}”.` });
          }
          break;
        case 'required_footer':
        case 'required_disclaimer':
          if (!ntext.includes(norm(r.value))) {
            push({ code: r.kind === 'required_footer' ? 'missing_footer' : 'missing_disclaimer', severity: r.severity, source: r.source, rule_id: r.id, connection_id: cid,
              message: `${r.kind === 'required_footer' ? 'Footer' : 'Disclaimer'} required: “${r.value}”.` });
          }
          break;
        default:
          break;
      }
    }
    // Approved link domains: when any exist, every link must be on one of them (or a trusted host).
    const domainRules = rules.filter((r) => r.kind === 'approved_link_domain');
    if (domainRules.length) {
      const domains = domainRules.map((r) => normaliseDomain(r.value)).filter((d): d is string => !!d);
      const severity: RuleSeverity = domainRules.some((r) => r.severity === 'mandatory') ? 'mandatory' : 'advisory';
      const links = [...new Set([...(v.link ? [v.link] : []), ...extractUrls(text)])];
      for (const l of links) {
        const host = hostOf(l);
        if (host && (input.trustedHosts ?? []).includes(host)) continue;
        if (!host || !hostAllowed(host, domains)) {
          push({ code: 'unapproved_link', severity, source: 'brand_rule', connection_id: cid, message: `Link not on an approved domain: ${host ?? l}.` });
        }
      }
    }
    // TipSignal: exact facts (date, time, probability, score, result, names, source link) must survive; no promises.
    if (input.tipsignal) {
      const issues = checkSuggestion({ sourceText: input.tipsignal.sourceText, allowedText: input.allowedText ?? '', text, strict: true, requiredPhrases: input.tipsignal.requiredPhrases });
      for (const i of issues) {
        const code = TS_CODE[i.code];
        if (code) push({ code, severity: 'mandatory', source: 'tipsignal', connection_id: cid, message: i.message });
      }
    }
  }

  if (input.tipsignal?.type === 'picks.ready' && input.tipsignal.kickoffAt.getTime() <= input.at.getTime()) {
    push({ code: 'tipsignal_expired', severity: 'mandatory', source: 'tipsignal', message: 'This pick would publish after kick-off. Picks expire at kick-off.' });
  }

  // Assets
  const used = new Set(variants.flatMap((v) => v.assetIds));
  for (const a of input.assets.filter((x) => used.has(x.id))) {
    const label = a.name ?? 'An asset';
    if (a.expires_at && a.expires_at.getTime() <= now.getTime()) {
      push({ code: 'asset_expired', severity: 'mandatory', source: 'asset', asset_id: a.id, message: `${label}: licence/usage expired ${a.expires_at.toISOString().slice(0, 10)}.` });
    } else if (a.expires_at && a.expires_at.getTime() <= input.at.getTime()) {
      push({ code: 'asset_expires_before_publish', severity: 'mandatory', source: 'asset', asset_id: a.id, message: `${label}: expires ${a.expires_at.toISOString().slice(0, 10)}, before this publishes.` });
    }
    if (a.lifecycle === 'superseded') push({ code: 'asset_superseded', severity: 'advisory', source: 'asset', asset_id: a.id, message: `${label} has been superseded${a.superseded_by ? ' by a newer version' : ''}.` });
    if (a.lifecycle === 'archived') push({ code: 'asset_archived', severity: 'advisory', source: 'asset', asset_id: a.id, message: `${label} is archived in brand governance.` });
  }

  // Collapse identical findings reported for every destination into one base-level finding.
  const key = (f: BrandFinding) => `${f.code}|${f.severity}|${f.rule_id ?? ''}|${f.asset_id ?? ''}|${f.message}`;
  const groups = new Map<string, BrandFinding[]>();
  for (const f of raw) groups.set(key(f), [...(groups.get(key(f)) ?? []), f]);
  const out: BrandFinding[] = [];
  for (const g of groups.values()) {
    const ids = new Set(g.map((f) => f.connection_id));
    if (variants.length > 1 && ids.size === variants.length && !ids.has(null)) out.push({ ...g[0]!, connection_id: null });
    else {
      const seen = new Set<string | null>();
      for (const f of g) if (!seen.has(f.connection_id)) { seen.add(f.connection_id); out.push(f); }
    }
  }
  return out;
}

export function splitFindings(f: BrandFinding[]): { mandatory: BrandFinding[]; advisory: BrandFinding[] } {
  return { mandatory: f.filter((x) => x.severity === 'mandatory'), advisory: f.filter((x) => x.severity === 'advisory') };
}
