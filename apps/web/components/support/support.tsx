'use client';
// V3.1 §16 release + support:
//  - "What's new": GET /api/release-notes (unseen count → badge), opening marks the latest version seen.
//  - "Report a problem": nothing is attached unless chosen; a redaction preview shows what will be sent. The server
//    redacts again (authoritative) and returns how many values it removed. Never credentials, never whole drafts.
//  - Feature flags admin (workspace-scoped overrides; safe default off).
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { CircleCheck, Flag, Send, Sparkles } from 'lucide-react';
import { ShareReportDialog } from './share-report';
import {
  SUPPORT_CATEGORIES, type FeatureFlagsResponse, type ReleaseNotesResponse, type SupportCategory, type SupportReportDto,
} from '@social-lite/core/contracts/v31-gov';
import { api, recentCorrelationIds } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useFlags } from '@/lib/client/flags';
import { fmtDate } from '@/lib/client/format';
import {
  Badge, Button, Card, CardHeader, Checkbox, Dialog, Drawer, EmptyState, ErrorNotice, ErrorState, Field, MetaChip, Segmented, Skeleton, Textarea, useToast,
} from '@/components/ui';

// ------------------------------------------------------------------ release notes
export function useReleaseNotes(enabled: boolean) {
  return useApi<ReleaseNotesResponse>(enabled ? '/api/release-notes' : null);
}

export function WhatsNewDrawer({ open, onOpenChange, notes, onSeen }: { open: boolean; onOpenChange: (o: boolean) => void; notes: ReleaseNotesResponse | undefined; onSeen: (r: ReleaseNotesResponse) => void }) {
  useEffect(() => {
    if (!open || !notes?.unseen || !notes.notes[0]) return;
    void api.post<ReleaseNotesResponse>('/api/release-notes', { version: notes.notes[0].version }).then(onSeen).catch(() => undefined);
  }, [open, notes, onSeen]);
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="What’s new">
      {!notes ? <Skeleton className="h-40 w-full rounded-lg" /> : !notes.notes.length ? <EmptyState compact icon={<Sparkles aria-hidden />} title="Nothing new" /> : (
        <ol className="flex flex-col gap-6" data-testid="release-notes">
          {notes.notes.map((n) => (
            <li key={n.version}>
              <p className="text-xs text-muted">{fmtDate(n.date, 'UTC')} · v{n.version}</p>
              <h3 className="mb-2 text-[15px] font-semibold">{n.title}</h3>
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {n.items.map((i) => <li key={i} className="flex items-start gap-2"><CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />{i}</li>)}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Drawer>
  );
}

// ------------------------------------------------------------------ report a problem
// Mirror of services/gov/release.ts REDACTIONS, for the preview only (the server's redaction is what counts).
const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '<redacted-auth>'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '<redacted-jwt>'],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-bot-token>'],
  [/\b(?:sk|pk|rk|xox[abpr]|ghp|gho|ghs|github_pat|glpat|AKIA|ya29)[-_.A-Za-z0-9]{10,}/g, '<redacted-key>'],
  [/\b((?:access|refresh|id)?_?token|secret|password|passwd|pwd|api[_-]?key|client_secret|code|signature|authorization|cookie|session)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s&,;]+)/gi, '$1=<redacted>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '<redacted-long-value>'],
  [/\b(?:\d[ -]?){13,19}\b/g, '<redacted-number>'],
];
function previewRedact(input: string): { text: string; count: number } {
  let count = 0;
  let text = input.normalize('NFKC');
  for (const [re, rep] of REDACTIONS) text = text.replace(re, (...m) => { count++; return rep.replace('$1', String(m[1] ?? '')); });
  return { text, count };
}

/** Browser family only (never the user agent string). */
function browserFamily(): string | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  if (/SamsungBrowser/i.test(ua)) return 'samsung';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

const CATEGORY_LABEL: Record<SupportCategory, string> = { bug: 'Something broke', publishing: 'Publishing', integration: 'Connection', performance: 'Slow', account: 'Account', other: 'Other' };

export function ReportProblemDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const pathname = usePathname();
  const toast = useToast();
  const notes = useReleaseNotes(open);
  const [category, setCategory] = useState<SupportCategory>('bug');
  const [summary, setSummary] = useState('');
  const [withRoute, setWithRoute] = useState(false);
  const [withRefs, setWithRefs] = useState(false);
  const [withDraft, setWithDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [sent, setSent] = useState<SupportReportDto | null>(null);
  const [sharing, setSharing] = useState(false);
  const refs = useMemo(() => (open ? recentCorrelationIds() : []), [open]);
  const postId = /^\/posts\/([0-9a-f-]{36})/.exec(pathname ?? '')?.[1] ?? null;
  useEffect(() => { if (open) { setSent(null); setErr(null); setWithRoute(false); setWithRefs(false); setWithDraft(false); } }, [open]);
  const red = previewRedact(summary);
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<SupportReportDto>('/api/support/reports', {
        category, summary: summary.trim(), route: withRoute ? pathname : null, app_version: notes.data?.current_version ?? null,
        occurred_at: new Date().toISOString(), correlation_ids: withRefs ? refs.map((r) => r.id) : [], include_draft_post_id: withDraft && postId ? postId : null,
        browser_family: browserFamily(),
      }, { idempotent: true });
      setSent(r);
      setSummary('');
      toast.success('Report sent');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      busy={busy}
      title="Report a problem"
      footer={sent ? <>
        <Button variant="ghost" onClick={() => setSharing(true)} icon={<Send aria-hidden className="size-4" />}>Send to Relay support</Button>
        <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button>
      </> : <>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => void send()} disabledReason={!summary.trim() ? 'Describe the problem.' : null}>Send</Button>
      </>}
    >
      {sent ? (
        <div className="flex flex-col gap-2 text-[13px]" data-testid="support-sent">
          <p className="flex items-center gap-2 font-medium"><CircleCheck aria-hidden className="size-4 text-success" />Sent · reference {sent.id.slice(0, 8)}</p>
          <p className="text-muted">{sent.redactions ? `${sent.redactions} value${sent.redactions === 1 ? '' : 's'} redacted by the server.` : 'Nothing needed redacting.'}</p>
          <p className="text-muted">Saved for your workspace admins. Relay staff only see it if you send it.</p>
          <ShareReportDialog reportId={sent.id} open={sharing} onOpenChange={setSharing} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Segmented label="Category" value={category} onChange={setCategory} size="sm" className="flex-wrap" options={SUPPORT_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} />
          <Field label="What happened?"><Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} maxLength={4000} autoFocus /></Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-medium">Attach <span className="font-normal text-subtle">Nothing unless ticked</span></legend>
            <Checkbox label="This page’s address" description={pathname ?? undefined} checked={withRoute} onChange={(e) => setWithRoute(e.target.checked)} />
            <Checkbox label={`Error references (${refs.length})`} description={refs.length ? refs.slice(0, 3).map((r) => r.id.slice(0, 8)).join(', ') : 'None this session'} disabled={!refs.length} checked={withRefs} onChange={(e) => setWithRefs(e.target.checked)} />
            {postId ? <Checkbox label="A short excerpt of this draft" description="First 500 characters, redacted" checked={withDraft} onChange={(e) => setWithDraft(e.target.checked)} /> : null}
          </fieldset>
          <div className="rounded-lg bg-sunken p-3" data-testid="redaction-preview">
            <p className="mb-1 flex items-center gap-2 text-xs text-muted">Will be sent{red.count ? <Badge tone="info">{red.count} redacted</Badge> : null}</p>
            <p className="whitespace-pre-wrap break-words text-[13px]">{red.text.trim() || <span className="text-muted">—</span>}</p>
            <p className="mt-2 text-xs text-muted">
              {[`Category: ${CATEGORY_LABEL[category]}`, notes.data ? `Version ${notes.data.current_version}` : null, withRoute ? `Page ${pathname}` : null, withRefs ? `${refs.length} references` : null, withDraft && postId ? 'Draft excerpt' : null].filter(Boolean).join(' · ')}
            </p>
          </div>
          {err ? <ErrorNotice error={err} /> : null}
        </div>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ feature flags admin
export function FeatureFlagsSettings() {
  const flags = useFlags();
  const toast = useToast();
  const { data, error, refetch, setData } = useApi<FeatureFlagsResponse>('/api/feature-flags');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return <Skeleton className="h-64 w-full max-w-3xl rounded-xl" />;
  const set = async (key: string, v: 'default' | 'on' | 'off') => {
    setBusy(key); setErr(null);
    try {
      setData(await api.put<FeatureFlagsResponse>(`/api/feature-flags/${key}`, { enabled: v === 'default' ? null : v === 'on' }));
      await flags.refetch();
      toast.success('Saved');
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  return (
    <Card className="max-w-3xl">
      <CardHeader title="Features" actions={data.can_override ? null : <MetaChip>View only</MetaChip>} />
      {err ? <ErrorNotice error={err} className="mx-4" /> : null}
      <ul className="divide-y divide-border" aria-label="Feature flags">
        {data.flags.map((f) => (
          <li key={f.key} className="flex flex-wrap items-center gap-3 px-4 py-3" data-flag={f.key}>
            <Flag aria-hidden className="size-4 shrink-0 text-subtle" />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium">{f.description}</p>
              <p className="text-xs text-muted">{f.enabled ? 'On' : 'Off'} · {f.source === 'workspace_override' ? 'set here' : f.source === 'killed' ? 'switched off for everyone' : f.source === 'rollout' ? 'rollout' : 'default'}</p>
            </div>
            {data.can_override && f.source !== 'killed' ? (
              <Segmented size="sm" label={`${f.description} setting`} value={f.workspace_override === null ? 'default' : f.workspace_override ? 'on' : 'off'}
                onChange={(v) => void set(f.key, v)} options={[{ value: 'default', label: 'Default', disabled: busy === f.key }, { value: 'on', label: 'On', disabled: busy === f.key }, { value: 'off', label: 'Off', disabled: busy === f.key }]} />
            ) : <Badge tone={f.enabled ? 'success' : 'neutral'}>{f.enabled ? 'On' : 'Off'}</Badge>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

