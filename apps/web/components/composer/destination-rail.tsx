'use client';
// Composer left region: which content you are editing (Base or one destination's variant) and a searchable,
// network-grouped destination selector for all ten networks (no truncated tab strip).
import { useMemo, useState } from 'react';
import { FileText, Search } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABEL, type VariantDraft } from '@social-lite/core';
import { connectionFix, isDispatchable } from '@/lib/client/connection-fix';
import type { Connection } from '@/lib/client/types';
import { Checkbox, cn, ConnectionStatusBadge, PlatformIcon, SimulatedBadge } from '@/components/ui';

export function ContentSwitcher({
  selected, variants, active, onActive, issueCount,
}: { selected: Connection[]; variants: VariantDraft[]; active: string; onActive: (id: string) => void; issueCount: (id: string) => number }) {
  return (
    <nav aria-label="Content to edit">
      <ul className="flex flex-col gap-0.5">
        <li>
          <SwitchRow active={active === 'base'} onClick={() => onActive('base')}
            icon={<span aria-hidden className="flex size-7 items-center justify-center rounded-md bg-raised text-muted"><FileText className="size-4" /></span>}
            title="Base content" sub={selected.length ? `Shared by ${selected.length === 1 ? '1 destination' : `${selected.length} destinations`}` : 'No destinations yet'} />
        </li>
        {selected.map((c) => {
          const v = variants.find((x) => x.connectionId === c.id);
          const custom = !!v && (!v.inheritText || !v.inheritMedia);
          const n = issueCount(c.id);
          return (
            <li key={c.id}>
              <SwitchRow active={active === c.id} onClick={() => onActive(c.id)}
                icon={<PlatformIcon provider={c.provider} size="sm" decorative />}
                title={c.display_name}
                sub={<>{PROVIDER_LABEL[c.provider]}{custom ? ' · Custom' : ''}</>}
                trailing={n ? <span className="rounded-full bg-danger-soft px-1.5 text-[11px] font-semibold leading-5 text-danger tabular">{n}<span className="sr-only"> issue{n === 1 ? '' : 's'}</span></span> : null}
                label={`${PROVIDER_LABEL[c.provider]} ${c.display_name}${custom ? ', custom content' : ', base content'}`} />
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function SwitchRow({ active, onClick, icon, title, sub, trailing, label }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; title: React.ReactNode; sub: React.ReactNode; trailing?: React.ReactNode; label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      aria-label={label}
      className={cn('relative flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors', active ? 'bg-raised' : 'hover:bg-raised/60')}
    >
      {active ? <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-accent" /> : null}
      {icon}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-[13px] font-medium', !active && 'text-fg/90')}>{title}</span>
        <span className="block truncate text-[11px] text-muted">{sub}</span>
      </span>
      {trailing}
    </button>
  );
}

export function DestinationSelector({
  connections, selected, onToggle, readOnly,
}: { connections: Connection[]; selected: string[]; onToggle: (c: Connection, on: boolean) => void; readOnly: boolean }) {
  const [q, setQ] = useState('');
  const live = connections.filter((c) => c.status !== 'disconnected' || selected.includes(c.id));
  const term = q.trim().toLowerCase();
  // Demo/simulated status is shown once per workspace; per-row provenance only when real and simulated destinations mix.
  const mixed = live.some((c) => c.is_mock) && live.some((c) => !c.is_mock);
  const groups = useMemo(() => PROVIDERS.map((p) => ({
    p,
    list: live.filter((c) => c.provider === p && (!term || `${c.display_name} ${c.username ?? ''} ${PROVIDER_LABEL[p]}`.toLowerCase().includes(term))),
  })).filter((g) => g.list.length), [live, term]);
  if (!live.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {live.length > 6 ? (
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <label htmlFor="dest-search" className="sr-only">Search destinations</label>
          <input id="dest-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search destinations"
            className="h-9 w-full rounded-lg border border-border bg-sunken pl-8 pr-3 text-[13px] placeholder:text-subtle hover:border-border-strong" />
        </div>
      ) : null}
      {!groups.length ? <p className="px-2 text-[13px] text-muted">No matches</p> : null}
      {groups.map(({ p, list }) => (
        <div key={p} role="group" aria-labelledby={`dg-${p}`}>
          <p id={`dg-${p}`} className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-[0.05em] text-subtle">
            <PlatformIcon provider={p} size="xs" decorative className="size-4 rounded-[4px] [&>svg]:size-2.5" />{PROVIDER_LABEL[p]}
          </p>
          <ul className="flex flex-col">
            {list.map((c) => {
              const on = selected.includes(c.id);
              // Paused destinations can still be scheduled (they send once resumed); others must be fixed first.
              const ok = isDispatchable(c) || c.status === 'paused' || (c.paused && (c.status === 'ready' || c.status === 'expiring'));
              const reason = isDispatchable(c) ? null : connectionFix(c) ?? c.health?.message ?? c.status_label;
              return (
                <li key={c.id} className={cn('rounded-lg px-1.5 py-1.5', on && 'bg-accent-soft')}>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      className="min-w-0 flex-1 [&_label]:block [&_label]:truncate"
                      checked={on}
                      disabled={readOnly || (!ok && !on)}
                      onChange={(e) => onToggle(c, e.target.checked)}
                      label={<span className="min-w-0 truncate text-[13px]" title={c.display_name}>{c.display_name}<span className="sr-only"> ({PROVIDER_LABEL[c.provider]})</span></span>}
                    />
                    {c.status !== 'ready' ? <ConnectionStatusBadge status={c.status} label={c.status_label} size="sm" /> : null}
                    {c.is_mock && mixed ? <SimulatedBadge className="shrink-0" /> : null}
                  </div>
                  {reason ? <p className="mt-0.5 truncate pl-7 text-[11px] text-muted" title={reason}>{reason}</p> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
