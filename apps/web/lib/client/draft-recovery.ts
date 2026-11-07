'use client';
// V3.1 §9 browser-side draft recovery (contract: docs/V3_1_DATA_API.md "Local recovery storage").
//  - Storage follows the workspace policy from GET /api/session → draft_recovery: persistent = localStorage,
//    session = sessionStorage (tab lifetime), off = store nothing.
//  - Keys are `${namespace}:${post_id}`; the namespace already includes user + workspace, so another workspace's
//    copies are never read.
//  - Only { base_version, draft, title, saved_at } is stored; entries older than max_age_hours are dropped.
//  - A local copy is "Saved locally" — never "Saved". Only an autosave response with status 'saved' means saved.
import type { DraftContent } from '@social-lite/core';
import type { DraftRecoveryPolicy } from '@social-lite/core/contracts/v31-data';

export interface LocalDraft { base_version: number; draft: DraftContent; title: string | null; saved_at: string }

function store(policy: DraftRecoveryPolicy | null | undefined): Storage | null {
  if (!policy || policy.local_recovery === 'off' || typeof window === 'undefined') return null;
  try {
    return policy.local_recovery === 'persistent' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

const keyOf = (policy: DraftRecoveryPolicy, postId: string) => `${policy.namespace}:${postId}`;

export function recoveryEnabled(policy: DraftRecoveryPolicy | null | undefined): boolean {
  return store(policy) !== null;
}

export function writeLocalDraft(policy: DraftRecoveryPolicy | null | undefined, postId: string, value: Omit<LocalDraft, 'saved_at'>): boolean {
  const s = store(policy);
  if (!s || !policy) return false;
  try {
    const entry: LocalDraft = { base_version: value.base_version, draft: value.draft, title: value.title, saved_at: new Date().toISOString() };
    s.setItem(keyOf(policy, postId), JSON.stringify(entry));
    return true;
  } catch {
    return false; // quota / disabled storage: the UI then shows "Not saved" instead of "Saved locally"
  }
}

export function readLocalDraft(policy: DraftRecoveryPolicy | null | undefined, postId: string): LocalDraft | null {
  const s = store(policy);
  if (!s || !policy) return null;
  try {
    const raw = s.getItem(keyOf(policy, postId));
    if (!raw) return null;
    const v = JSON.parse(raw) as LocalDraft;
    const age = Date.now() - Date.parse(v.saved_at);
    if (!Number.isFinite(age) || age > policy.max_age_hours * 3600_000 || !v.draft || !Number.isInteger(v.base_version)) {
      s.removeItem(keyOf(policy, postId));
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

export function clearLocalDraft(policy: DraftRecoveryPolicy | null | undefined, postId: string): void {
  if (!policy) return;
  // Clear from both stores: the policy may have changed since the copy was written.
  for (const s of [safe(() => window.localStorage), safe(() => window.sessionStorage)]) {
    try { s?.removeItem(keyOf(policy, postId)); } catch { /* ignore */ }
  }
}

/** Drop every local copy in this namespace (logout with clear_on_logout, or policy switched to off). */
export function clearNamespace(policy: DraftRecoveryPolicy | null | undefined): void {
  if (!policy) return;
  for (const s of [safe(() => window.localStorage), safe(() => window.sessionStorage)]) {
    if (!s) continue;
    try {
      for (const k of Object.keys(s)) if (k.startsWith(`${policy.namespace}:`)) s.removeItem(k);
    } catch { /* ignore */ }
  }
}

/** Drop expired copies in this namespace (run once per session load). */
export function pruneNamespace(policy: DraftRecoveryPolicy | null | undefined): void {
  if (!policy) return;
  if (policy.local_recovery === 'off') { clearNamespace(policy); return; }
  for (const s of [safe(() => window.localStorage), safe(() => window.sessionStorage)]) {
    if (!s) continue;
    try {
      for (const k of Object.keys(s)) {
        if (!k.startsWith(`${policy.namespace}:`)) continue;
        const v = JSON.parse(s.getItem(k) ?? 'null') as LocalDraft | null;
        if (!v || Date.now() - Date.parse(v.saved_at) > policy.max_age_hours * 3600_000) s.removeItem(k);
      }
    } catch { /* ignore */ }
  }
}

function safe<T>(f: () => T): T | null {
  try { return f(); } catch { return null; }
}

/** Same content as the server copy (no recovery needed). */
export function sameContent(a: { draft: DraftContent; title: string | null }, b: { draft: DraftContent; title: string | null }): boolean {
  return stable(a.draft) === stable(b.draft) && (a.title ?? '') === (b.title ?? '');
}

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

let tabClientId: string | null = null;
/** One id per editor tab (8-64 [A-Za-z0-9_-]); the server uses it to order this tab's saves. */
export function editorClientId(): string {
  if (!tabClientId) {
    const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    tabClientId = `tab_${r.slice(0, 24)}`;
  }
  return tabClientId;
}

let tabRevision = 0;
/** Monotonic per tab (the client id is per tab too); a retry of the same save reuses its revision. */
export function nextClientRevision(): number {
  tabRevision += 1;
  return tabRevision;
}
