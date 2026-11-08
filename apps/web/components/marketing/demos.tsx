'use client';
// Interactive product demonstrations (brief §4): small, self-contained client islands with synthetic example content. They
// never call an API, never load the app and never show private data. Each is labelled "Example".
import { useState } from 'react';
import { ArrowUp, Check, CircleDashed, Clock, LoaderCircle, Sparkles } from 'lucide-react';
import { PlatformIcon } from '@/components/ui/platform-icon';
import { cn } from '@/components/ui-v5/cn';

function ExampleTag() {
  return <span className="rounded-full bg-v5-raised px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-v5-muted">Example</span>;
}

function Tabs<T extends string>({ label, items, value, onChange }: { label: string; items: Array<{ id: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {items.map((t) => (
        <button key={t.id} type="button" aria-pressed={value === t.id} onClick={() => onChange(t.id)}
          className={cn('min-h-8 rounded-full px-3 text-[12px] font-semibold outline-none transition-colors focus-visible:outline-2 focus-visible:outline-v5-ring', value === t.id ? 'bg-v5-primary text-v5-on-primary' : 'text-v5-muted hover:bg-v5-raised hover:text-v5-fg')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ publishing: per-network limits as you pick networks
const CAPTION = 'Our spring menu lands Wednesday — five new dishes, two returning favourites and a weekend brunch you’ll want to share with friends. Book a table from the link in our profile, drop by and say hello to the kitchen team, or tag us in your photos so we can share our favourites next week.';
const NETS = [
  { id: 'instagram', limit: 2200 }, { id: 'facebook', limit: 10000 }, { id: 'x', limit: 280 }, { id: 'linkedin', limit: 3000 }, { id: 'bluesky', limit: 300 },
] as const;
type NetId = (typeof NETS)[number]['id'];
const NET_LABEL: Record<NetId, string> = { instagram: 'Instagram', facebook: 'Facebook', x: 'X', linkedin: 'LinkedIn', bluesky: 'Bluesky' };

export function ComposerDemo() {
  const [on, setOn] = useState<NetId[]>(['instagram', 'facebook', 'x']);
  const len = [...CAPTION].length;
  const over = NETS.filter((n) => on.includes(n.id) && len > n.limit);
  return (
    <div className="flex h-full flex-col gap-3 rounded-2xl border border-v5-border bg-v5-surface p-4 shadow-[var(--mkt-shadow)]">
      <div className="flex items-center justify-between"><p className="text-[13px] font-bold text-v5-fg">New post</p><ExampleTag /></div>
      <p className="rounded-xl bg-v5-raised p-3 text-[12px] leading-relaxed text-v5-fg"><span className="line-clamp-3">{CAPTION}</span></p>
      <div role="group" aria-label="Networks for this example post" className="flex flex-wrap gap-1.5">
        {NETS.map((n) => {
          const active = on.includes(n.id);
          return (
            <button key={n.id} type="button" aria-pressed={active} onClick={() => setOn((v) => (active ? v.filter((x) => x !== n.id) : [...v, n.id]))}
              className={cn('inline-flex min-h-9 items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-[12px] font-medium outline-none focus-visible:outline-2 focus-visible:outline-v5-ring', active ? 'border-v5-primary-text bg-v5-primary-soft text-v5-fg' : 'border-v5-border text-v5-muted opacity-70 hover:opacity-100')}>
              <PlatformIcon provider={n.id} size="xs" decorative />{NET_LABEL[n.id]}
            </button>
          );
        })}
      </div>
      <p aria-live="polite" className={cn('text-[12px] font-medium', over.length ? 'text-v5-warn' : 'text-v5-success')}>
        {on.length === 0 ? 'Pick at least one network.' : over.length ? `${len} characters · too long for ${over.map((n) => `${NET_LABEL[n.id]} (${n.limit})`).join(', ')} — shorten it for that network.` : `${len} characters · fits every selected network.`}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-v5-border px-2.5 py-1 text-[12px] text-v5-fg"><Clock aria-hidden className="size-3.5" />Wed 11 · 09:30</span>
        <span className={cn('ml-auto rounded-full px-3.5 py-1.5 text-[12px] font-semibold', on.length && !over.length ? 'bg-v5-primary text-v5-on-primary' : 'bg-v5-raised text-v5-muted')} aria-hidden>Schedule</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ inbox: filter by conversation type
type Kind = 'all' | 'comment' | 'message' | 'mention';
const ROWS: Array<{ who: string; initials: string; provider: 'instagram' | 'facebook' | 'youtube' | 'bluesky'; kind: Exclude<Kind, 'all'>; text: string; ago: string; unread: boolean }> = [
  { who: 'Maya R.', initials: 'MR', provider: 'instagram', kind: 'message', text: 'Is the brunch menu vegan-friendly?', ago: '2m', unread: true },
  { who: 'Tom B.', initials: 'TB', provider: 'facebook', kind: 'comment', text: 'Booked for Saturday — can’t wait!', ago: '14m', unread: true },
  { who: 'Priya S.', initials: 'PS', provider: 'youtube', kind: 'comment', text: 'What camera did you film this on?', ago: '1h', unread: false },
  { who: 'Leo K.', initials: 'LK', provider: 'bluesky', kind: 'mention', text: 'Best flat white in town, honestly.', ago: '3h', unread: false },
];

export function InboxDemo() {
  const [kind, setKind] = useState<Kind>('all');
  const rows = ROWS.filter((r) => kind === 'all' || r.kind === kind);
  return (
    <div className="flex h-full flex-col gap-3 rounded-2xl border border-v5-border bg-v5-surface p-4 shadow-[var(--mkt-shadow)]">
      <div className="flex items-center justify-between"><p className="text-[13px] font-bold text-v5-fg">Inbox</p><ExampleTag /></div>
      <Tabs label="Conversation type" value={kind} onChange={setKind} items={[{ id: 'all', label: 'All' }, { id: 'comment', label: 'Comments' }, { id: 'message', label: 'DMs' }, { id: 'mention', label: 'Mentions' }]} />
      <ul className="flex flex-col gap-1.5" aria-live="polite">
        {rows.map((r) => (
          <li key={r.who} className="flex items-center gap-3 rounded-xl p-2 hover:bg-v5-raised">
            <span aria-hidden className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-v5-primary-soft text-[11px] font-bold text-v5-primary-text">
              {r.initials}
              <span className="absolute -bottom-0.5 -right-0.5 flex"><PlatformIcon provider={r.provider} size="xs" decorative className="!size-4 ring-2 ring-[var(--v5-surface)] [&>svg]:!size-2.5" /></span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[12px]"><span className="font-semibold text-v5-fg">{r.who}</span><span className="text-v5-muted">{r.ago}</span></span>
              <span className="block truncate text-[12px] text-v5-muted">{r.text}</span>
            </span>
            {r.unread ? <span className="size-2 shrink-0 rounded-full bg-v5-primary-text"><span className="sr-only">Unread</span></span> : null}
          </li>
        ))}
      </ul>
      <p className="mt-auto text-[12px] text-v5-muted">Assign, add internal notes and reply where each network allows it.</p>
    </div>
  );
}

// ------------------------------------------------------------------ analytics: range toggle on example data
const SERIES = {
  '7': [42, 48, 45, 58, 54, 66, 71],
  '28': [30, 34, 33, 38, 36, 41, 40, 44, 43, 47, 45, 50, 49, 52, 50, 55, 53, 58, 57, 60, 58, 63, 61, 66, 64, 69, 67, 72],
} as const;

export function AnalyticsDemo() {
  const [range, setRange] = useState<'7' | '28'>('28');
  const pts = SERIES[range];
  const max = Math.max(...pts), min = Math.min(...pts);
  const W = 300, H = 96;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * W, H - 8 - ((v - min) / (max - min || 1)) * (H - 20)] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return (
    <div className="flex h-full flex-col gap-3 rounded-2xl border border-v5-border bg-v5-surface p-4 shadow-[var(--mkt-shadow)]">
      <div className="flex items-center justify-between gap-2"><p className="text-[13px] font-bold text-v5-fg">Performance</p><ExampleTag /></div>
      <Tabs label="Date range" value={range} onChange={setRange} items={[{ id: '7', label: 'Last 7 days' }, { id: '28', label: 'Last 28 days' }]} />
      <dl className="grid grid-cols-3 gap-2">
        {[['Engagement', range === '7' ? '1,240' : '4,810'], ['Reach', range === '7' ? '18.2k' : '71.5k'], ['Posts', range === '7' ? '9' : '38']].map(([k, v]) => (
          <div key={k} className="min-w-0 rounded-xl bg-v5-raised p-2">
            <dt className="text-[11px] text-v5-muted [overflow-wrap:anywhere]">{k}</dt>
            <dd className="truncate text-[14px] font-bold text-v5-fg">{v}</dd>
          </div>
        ))}
      </dl>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" role="img" aria-label={`Example engagement trend over the last ${range} days, rising`} preserveAspectRatio="none">
        <defs><linearGradient id="mkt-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--mkt-accent-from)" stopOpacity="0.28" /><stop offset="1" stopColor="var(--mkt-accent-from)" stopOpacity="0" /></linearGradient></defs>
        <path d={`${line} L${W} ${H} L0 ${H} Z`} fill="url(#mkt-area)" />
        <path d={line} fill="none" stroke="var(--mkt-accent-from)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <p className="mt-auto text-[12px] text-v5-muted">Coverage: 4 of 5 accounts reporting. Missing data shows as missing, never as zero.</p>
    </div>
  );
}

// ------------------------------------------------------------------ AI: suggested tasks → observable steps
const TASKS = [
  { id: 'brief', chip: 'Campaign from a brief', prompt: 'Turn the spring menu brief into posts for Instagram, Facebook and LinkedIn', steps: ['Reading the selected brief', 'Creating three channel drafts', 'Checking account requirements', 'Saved three drafts'] },
  { id: 'week', chip: 'Plan this week', prompt: 'Plan next week’s posts around our approved content', steps: ['Reading the calendar and approved content', 'Finding gaps and conflicts', 'Proposing five time slots', 'Ready for your review'] },
  { id: 'replies', chip: 'Draft replies', prompt: 'Draft replies to unanswered messages from today', steps: ['Reading 6 unanswered conversations', 'Summarising the questions', 'Drafting replies', 'Replies ready for review — nothing sent'] },
] as const;

export function AiDemo() {
  const [task, setTask] = useState<(typeof TASKS)[number]['id']>('brief');
  const t = TASKS.find((x) => x.id === task)!;
  return (
    <div className="flex h-full flex-col gap-3 rounded-2xl border border-v5-border bg-v5-surface p-4 shadow-[var(--mkt-shadow)]">
      <div className="flex items-center justify-between"><p className="flex items-center gap-1.5 text-[13px] font-bold text-v5-fg"><Sparkles aria-hidden className="size-4 text-v5-primary-text" />Ask Relay</p><ExampleTag /></div>
      <div className="flex items-end gap-2 rounded-xl border border-v5-border bg-v5-bg p-2.5">
        <p className="min-h-10 flex-1 text-[12px] leading-snug text-v5-fg">{t.prompt}</p>
        <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-v5-primary text-v5-on-primary"><ArrowUp className="size-4" /></span>
      </div>
      <Tabs label="Suggested tasks" value={task} onChange={setTask} items={TASKS.map((x) => ({ id: x.id, label: x.chip }))} />
      <ol className="flex flex-col gap-1.5" aria-live="polite" aria-label="Progress">
        {t.steps.map((s, i) => {
          const last = i === t.steps.length - 1;
          return (
            <li key={s} className="flex items-center gap-2 text-[12px]">
              {last ? <Check aria-hidden className="size-4 text-v5-success" /> : i === t.steps.length - 2 ? <LoaderCircle aria-hidden className="size-4 text-v5-primary-text" /> : <CircleDashed aria-hidden className="size-4 text-v5-muted" />}
              <span className={last ? 'font-semibold text-v5-fg' : 'text-v5-muted'}>{s}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-auto text-[12px] text-v5-muted">Publishing and sending always wait for your review.</p>
    </div>
  );
}
