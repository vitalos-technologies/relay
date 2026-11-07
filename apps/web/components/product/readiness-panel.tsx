'use client';
// Publishing readiness preflight in the composer dialogs: one compact list of checks (fails first, each
// with its fix), passes collapsed, and the duplicate/collision warning that must be acknowledged
// before Schedule / Publish is enabled. Reflects the SAVED draft (the dialog flushes first).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, CircleCheck, Copy, LoaderCircle } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useDebouncedValue } from '@/lib/client/hooks';
import { Banner, Checkbox, ToneIcon, cn } from '@/components/ui';

export interface ReadinessCheck { key: string; status: 'pass' | 'warn' | 'fail' | 'info'; title: string; message: string; connection_id: string | null; fix: string | null }
export interface DuplicateMatch { connection_id: string; other_post_id: string; other_title: string | null; other_excerpt: string; other_at: string; other_state: string; similarity: number; same_media: boolean; reason: string }
export interface ReadinessResult {
  ready: boolean; mode: string; needs_acknowledgement: boolean; summary: { fail: number; warn: number };
  checks: ReadinessCheck[]; duplicates: DuplicateMatch[]; duplicate_window_hours: number;
}

export interface ReadinessBody {
  mode: 'schedule' | 'publish' | 'submit'; connection_ids: string[];
  input_local_time?: string | null; timezone?: string | null; offset?: string | null; deadline_minutes?: number | null;
}

const ORDER: Record<ReadinessCheck['status'], number> = { fail: 0, warn: 1, info: 2, pass: 3 };

/**
 * Runs the preflight while `open` (debounced on body changes). Returns the panel to render and the
 * reason the primary action is blocked (failures, or an unacknowledged duplicate warning).
 */
export function useReadinessGate({ open, postId, body, prepare }: { open: boolean; postId: string; body: ReadinessBody; prepare?: () => Promise<unknown> }): { panel: ReactNode; blockReason: string | null } {
  const key = JSON.stringify(body);
  const debounced = useDebouncedValue(key, 350);
  const [result, setResult] = useState<ReadinessResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ack, setAck] = useState(false);
  const prepared = useRef(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) { prepared.current = false; setResult(null); setAck(false); setFailed(false); return; }
    const my = ++seq.current;
    setLoading(true);
    void (async () => {
      try {
        if (!prepared.current && prepare) { prepared.current = true; await prepare(); }
        const r = await api.post<ReadinessResult>(`/api/posts/${postId}/readiness`, JSON.parse(debounced));
        if (my !== seq.current) return;
        setResult(r); setFailed(false);
      } catch {
        if (my === seq.current) setFailed(true); // preflight unavailable: never block on our own outage
      } finally {
        if (my === seq.current) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, postId, debounced]);

  // A changed duplicate set needs a fresh acknowledgement.
  const dupKey = result?.duplicates.map((d) => `${d.connection_id}:${d.other_post_id}`).join(',') ?? '';
  useEffect(() => setAck(false), [dupKey]);

  const stale = debounced !== key || loading;
  const firstFail = result?.checks.find((c) => c.status === 'fail');
  const blockReason = !open ? null
    : stale && !result ? 'Checking…'
    : firstFail ? `${firstFail.title}: ${firstFail.message}`
    : result?.needs_acknowledgement && !ack ? 'Confirm the duplicate warning first.'
    : null;

  const panel = <ReadinessPanel result={result} loading={stale} failed={failed} ack={ack} onAck={setAck} />;
  return { panel, blockReason };
}

export function ReadinessPanel({ result, loading, failed, ack, onAck }: { result: ReadinessResult | null; loading: boolean; failed: boolean; ack: boolean; onAck: (v: boolean) => void }) {
  const [showPassed, setShowPassed] = useState(false);
  if (failed && !result) return <Banner tone="neutral" title="Preflight unavailable" />;
  if (!result) {
    return (
      <div role="status" className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-[13px] text-muted">
        <LoaderCircle aria-hidden className="size-4 anim-spin" /> Checking readiness…
      </div>
    );
  }
  const problems = result.checks.filter((c) => c.status !== 'pass' && c.key !== 'duplicates').sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const passed = result.checks.filter((c) => c.status === 'pass');
  return (
    <section aria-label="Readiness" aria-busy={loading} className={cn('flex flex-col gap-2 rounded-lg border border-border p-3', loading && 'opacity-70')}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold">
          {result.ready ? <CircleCheck aria-hidden className="size-4 text-success" /> : <ToneIcon tone="danger" />}
          {result.ready ? 'Ready' : `${result.summary.fail} to fix`}
          {result.summary.warn ? <span className="font-normal text-muted">· {result.summary.warn} warning{result.summary.warn === 1 ? '' : 's'}</span> : null}
        </h3>
        {loading ? <LoaderCircle aria-label="Re-checking" className="size-4 anim-spin text-muted" /> : null}
      </div>
      {problems.length ? (
        <ul className="flex flex-col gap-1.5" data-testid="readiness-problems">
          {problems.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px]">
              <ToneIcon tone={c.status === 'fail' ? 'danger' : c.status === 'warn' ? 'warn' : 'info'} className="mt-0.5" />
              <span className="min-w-0"><strong className="font-medium">{c.title}.</strong> {c.message}{c.fix ? <span className="text-muted"> {c.fix}</span> : null}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {result.duplicates.length ? (
        <div className="flex flex-col gap-2 rounded-md bg-warn-soft px-3 py-2" data-testid="duplicate-warning">
          <p className="flex items-center gap-2 text-[13px] font-medium"><Copy aria-hidden className="size-4 text-warn" /> Similar post to the same destination</p>
          <ul className="flex flex-col gap-1 text-xs">
            {result.duplicates.slice(0, 5).map((d, i) => (
              <li key={i}>
                <a className="underline underline-offset-2" href={`/posts/${d.other_post_id}`} target="_blank" rel="noreferrer">{d.other_title ?? d.other_excerpt}</a>
                <span className="text-muted"> · {d.same_media && d.similarity < 0.8 ? 'same media' : `${Math.round(d.similarity * 100)}% similar${d.same_media ? ', same media' : ''}`} · {d.other_state.replace(/_/g, ' ')} · {d.other_at.slice(0, 16).replace('T', ' ')} UTC</span>
              </li>
            ))}
          </ul>
          <Checkbox label="Post anyway" checked={ack} onChange={(e) => onAck(e.target.checked)} />
        </div>
      ) : null}
      {passed.length ? (
        <div>
          <button type="button" className="flex items-center gap-1 text-xs text-muted hover:text-fg" aria-expanded={showPassed} onClick={() => setShowPassed((v) => !v)}>
            <ChevronDown aria-hidden className={cn('size-3.5 transition-transform', showPassed && 'rotate-180')} /> {passed.length} checks passed
          </button>
          {showPassed ? (
            <ul className="mt-1.5 flex flex-col gap-1 text-xs text-muted">
              {passed.map((c, i) => <li key={i} className="flex items-start gap-1.5"><CircleCheck aria-hidden className="mt-px size-3.5 shrink-0 text-success" /><span><span className="text-fg">{c.title}:</span> {c.message}</span></li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
