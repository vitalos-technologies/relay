'use client';
// AI caption assistance (V1.1). A compact "Assist" popover in the composer. Suggestions open in a
// side panel as a diff (current text vs suggestion) per scope. Nothing changes until the user
// presses Accept; the composer then saves through PATCH /api/posts/:id with expected_version.
import { useState } from 'react';
import { FlaskConical, Hash, Layers, Megaphone, Recycle, Scissors, Sparkles } from 'lucide-react';
import { PROVIDER_LABEL, type DraftContent } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { diffWords } from '@/lib/client/diff';
import type { Connection } from '@/lib/client/types';
import {
  Badge, Button, Drawer, ErrorNotice, InfoTip, Input, PlatformIcon, Popover, PopoverContent, PopoverTrigger, ToneIcon, useToast,
} from '@/components/ui';

type Task = 'shorten' | 'tone' | 'variants' | 'hashtags' | 'repurpose';

export interface AiIssue { code: string; severity: 'block' | 'warn'; message: string }
export interface AiSuggestion { scope: string; before: string; text: string; hashtags: string[]; note: string | null; issues: AiIssue[]; rejected: boolean }
export interface AiSuggestResponse {
  suggestions: AiSuggestion[]; usage: { input: number; output: number; remaining: number; cap: number };
  fixture: boolean; model: string; post_version: number; notices: string[];
}
export interface AiStatusResponse { configured: boolean; reason: string | null; fixture: boolean; model: string; can_use: boolean; period: string; used: number; cap: number; remaining: number }

const TASKS: Array<{ id: Task; label: string; help: string; Icon: typeof Scissors }> = [
  { id: 'shorten', label: 'Shorten', help: 'Tighter copy. Facts and links are kept.', Icon: Scissors },
  { id: 'tone', label: 'Brand voice', help: 'Rewrite in the brand’s tone and terminology.', Icon: Megaphone },
  { id: 'variants', label: 'Per destination', help: 'One version per destination, within each platform’s limit.', Icon: Layers },
  { id: 'hashtags', label: 'Hashtags', help: 'Suggest hashtags to append.', Icon: Hash },
  { id: 'repurpose', label: 'Repurpose', help: 'New copy from a web page (https) or another post of this brand.', Icon: Recycle },
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const fmt = (n: number) => n.toLocaleString('en');

export function AiAssist({
  postId, draft, connections, tab, readOnly, flush, onAccept,
}: {
  postId: string;
  draft: DraftContent;
  /** Selected destinations. */
  connections: Connection[];
  /** Active composer tab: 'base' or a connection id. */
  tab: string;
  readOnly: boolean;
  flush: () => Promise<number | null>;
  onAccept: (scope: string, text: string) => void;
}) {
  const toast = useToast();
  const status = useApi<AiStatusResponse>('/api/ai/status');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<null | 'tone' | 'repurpose'>(null);
  const [field, setField] = useState('');
  const [busy, setBusy] = useState<Task | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<AiSuggestResponse | null>(null);
  const [items, setItems] = useState<AiSuggestion[]>([]);

  const s = status.data;
  const reason = readOnly ? 'View only' : status.error ? 'AI status unavailable' : !s ? null : !s.configured ? (s.reason ?? 'AI not configured') : !s.can_use ? 'You can’t edit drafts' : null;
  const onDestination = tab !== 'base' && connections.some((c) => c.id === tab);

  const run = async (task: Task) => {
    setError(null);
    const body: Record<string, unknown> = { task };
    if (task === 'variants') body.connection_ids = connections.map((c) => c.id);
    else if (onDestination) body.connection_ids = [tab];
    if (task === 'tone' && field.trim()) body.tone = field.trim();
    if (task === 'repurpose') {
      const v = field.trim();
      const id = /^https:\/\//i.test(v) && !v.includes('/posts/') ? null : v.match(UUID)?.[0];
      if (id) body.source_post_id = id;
      else body.source_url = v;
    }
    setBusy(task);
    try {
      const saved = await flush();
      if (saved === null) throw new Error('Save the draft before asking for suggestions.');
      const r = await api.post<AiSuggestResponse>(`/api/posts/${postId}/ai/suggest`, body);
      setResult(r);
      setItems(r.suggestions);
      setOpen(false);
      setForm(null);
      setField('');
      void status.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const currentText = (scope: string) => {
    if (scope === 'base') return draft.baseText;
    const v = draft.variants.find((x) => x.connectionId === scope);
    return !v || v.inheritText ? draft.baseText : (v.text ?? '');
  };
  const scopeLabel = (scope: string) => {
    const c = connections.find((x) => x.id === scope);
    return c ? <span className="flex min-w-0 items-center gap-2"><PlatformIcon provider={c.provider} size="xs" decorative /><span className="truncate">{c.display_name}</span><span className="sr-only">({PROVIDER_LABEL[c.provider]})</span></span> : 'Base';
  };
  const drop = (scope: string) => setItems((list) => {
    const next = list.filter((x) => x.scope !== scope);
    if (!next.length) setResult(null);
    return next;
  });

  const trigger = (
    <Button variant="ghost" size="md" icon={<Sparkles aria-hidden className="size-4" />} disabledReason={reason} loading={!!busy} aria-label="Assist with AI">
      <span className="sr-only sm:not-sr-only">Assist</span>
    </Button>
  );

  return (
    <>
      {reason ? trigger : <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setForm(null); setError(null); } }}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent label="AI assist" align="start" className="w-[300px] p-2">
          {form ? (
            <form className="flex flex-col gap-2 p-2" onSubmit={(e) => { e.preventDefault(); void run(form); }}>
              <label htmlFor="ai-field" className="text-[13px] font-medium">{form === 'tone' ? 'Tone (optional)' : 'Source link or post'}</label>
              <Input id="ai-field" autoFocus value={field} onChange={(e) => setField(e.target.value)} maxLength={form === 'tone' ? 200 : 2000}
                placeholder={form === 'tone' ? 'e.g. playful' : 'https://… or /posts/…'} />
              {error ? <ErrorNotice error={error} /> : null}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setForm(null); setError(null); }}>Back</Button>
                <Button type="submit" variant="primary" size="sm" loading={!!busy} disabledReason={form === 'repurpose' && !field.trim() ? 'Add a source' : null}>Suggest</Button>
              </div>
            </form>
          ) : (
            <>
              <ul className="flex flex-col" role="menu" aria-label="Assist tasks">
                {TASKS.map(({ id, label, help, Icon }) => {
                  const off = id === 'variants' && !connections.length ? 'Pick a destination first' : null;
                  return (
                    <li key={id} role="none" className="flex items-center">
                      <button
                        type="button" role="menuitem" disabled={!!busy || !!off} title={off ?? undefined}
                        onClick={() => (id === 'tone' || id === 'repurpose' ? setForm(id) : void run(id))}
                        className="flex h-9 flex-1 items-center gap-2.5 rounded-md px-2 text-left text-[13px] hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Icon aria-hidden className="size-4 text-muted" />
                        <span className="flex-1">{label}{id !== 'variants' && id !== 'repurpose' && onDestination ? <span className="text-subtle"> · this tab</span> : null}</span>
                        {busy === id ? <span className="text-xs text-subtle">…</span> : null}
                      </button>
                      <InfoTip label={`About ${label}`}>{help}</InfoTip>
                    </li>
                  );
                })}
              </ul>
              {error ? <div className="px-2 pt-2"><ErrorNotice error={error} /></div> : null}
              {s ? (
                <p className="flex items-center gap-1 border-t border-border px-2 pb-1 pt-2 text-xs text-subtle">
                  {s.fixture ? <Badge tone="warn" icon={<FlaskConical aria-hidden className="size-3" />} className="h-5 px-1.5 text-[11px]">Test fixture</Badge> : null}
                  <span className="tabular">{fmt(s.remaining)}</span> tokens left
                  <InfoTip label="About AI assist">Suggestions never change the draft until you accept them. Monthly allowance: {fmt(s.cap)} tokens.</InfoTip>
                </p>
              ) : null}
            </>
          )}
        </PopoverContent>
      </Popover>}

      <Drawer
        open={!!result}
        onOpenChange={(o) => { if (!o) { setResult(null); setItems([]); } }}
        title={<span className="flex items-center gap-2">Suggestions{result?.fixture ? <Badge tone="warn" icon={<FlaskConical aria-hidden className="size-3.5" />}>Test fixture</Badge> : null}</span>}
        description={result ? `${fmt(result.usage.remaining)} tokens left this month` : undefined}
      >
        {result?.notices.length ? (
          <ul className="mb-4 flex flex-col gap-1">{result.notices.map((n) => <li key={n} className="flex items-start gap-2 text-[13px] text-muted"><ToneIcon tone="info" className="mt-0.5" />{n}</li>)}</ul>
        ) : null}
        <ul className="flex flex-col gap-4">
          {items.map((sg) => {
            const now = currentText(sg.scope);
            const stale = now.trim() !== sg.before.trim();
            const blocked = sg.rejected ? 'Blocked by checks' : stale ? 'Text changed since — run Assist again' : readOnly ? 'View only' : null;
            return (
              <li key={sg.scope} className="rounded-lg border border-border" data-testid="ai-suggestion">
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-[13px] font-medium">
                  {scopeLabel(sg.scope)}
                  {sg.rejected ? <Badge tone="danger">Rejected</Badge> : sg.issues.length ? <Badge tone="warn">Check</Badge> : null}
                </div>
                <p className="whitespace-pre-wrap break-words px-3 py-3 text-[13px] leading-relaxed" aria-label="Changes">
                  {diffWords(sg.before, sg.text).map((p, i) => p.kind === 'same' ? <span key={i}>{p.text}</span>
                    : p.kind === 'add' ? <ins key={i} className="rounded-sm bg-success-soft text-success no-underline">{p.text}</ins>
                      : <del key={i} className="rounded-sm bg-danger-soft text-danger">{p.text}</del>)}
                </p>
                {sg.issues.length ? (
                  <ul className="flex flex-col gap-1 px-3 pb-2">
                    {sg.issues.map((i, n) => <li key={n} className="flex items-start gap-2 text-[12px]"><ToneIcon tone={i.severity === 'block' ? 'danger' : 'warn'} className="mt-0.5 size-3.5" />{i.message}</li>)}
                  </ul>
                ) : null}
                {sg.note ? <p className="px-3 pb-2 text-[12px] text-subtle">{sg.note}</p> : null}
                <div className="flex justify-end gap-2 px-3 pb-3">
                  <Button size="sm" variant="ghost" onClick={() => drop(sg.scope)}>Discard</Button>
                  <Button size="sm" variant="secondary" disabledReason={blocked} onClick={() => { onAccept(sg.scope, sg.text); drop(sg.scope); toast.success('Suggestion applied'); }}>Accept</Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Drawer>
    </>
  );
}
