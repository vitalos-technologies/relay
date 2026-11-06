'use client';
import { useState } from 'react';
import { CircleCheck, CircleDashed, ExternalLink, KeyRound, Server, Wrench } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import type { SetupGroup, SetupItem } from '@/lib/client/types';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNotice, ErrorState, Input, PageHeader, SkeletonRows, useToast } from '@/components/ui';

export default function SetupPage() {
  const { can } = useSession();
  const { data, error, loading, refetch, setData } = useApi<{ groups: SetupGroup[] }>(can('setup.manage') ? '/api/setup' : null);
  if (!can('setup.manage')) {
    return <><PageHeader title="Setup" /><EmptyState icon={<Wrench aria-hidden />} title="Only the workspace owner can change setup">Ask the owner to configure networks, storage, email and sign-in.</EmptyState></>;
  }
  const total = data?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0;
  const done = data?.groups.reduce((n, g) => n + g.items.filter((i) => i.is_set).length, 0) ?? 0;
  const replace = (it: SetupItem) => setData((d) => ({ groups: (d?.groups ?? []).map((g) => ({ ...g, items: g.items.map((x) => (x.key === it.key ? it : x)) })) }));

  return (
    <>
      <PageHeader
        title="Setup"
        description="Connect Social Lite to the services it needs. Secret values are write-only: once saved they’re never shown again."
        actions={data ? <span className="text-[13px] text-muted tabular">{done} of {total} configured</span> : null}
      />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={5} /> : (
        <div className="flex max-w-3xl flex-col gap-6">
          {data.groups.map((g) => {
            const set = g.items.filter((i) => i.is_set).length;
            const ready = g.ready ?? set === g.items.length;
            return (
              <Card key={g.id} aria-labelledby={`g-${g.id}`}>
                <CardHeader
                  id={`g-${g.id}`}
                  title={<>{g.title}{g.required === false ? <span className="ml-2 text-xs font-normal text-muted">Optional</span> : null}</>}
                  actions={ready
                    ? <Badge tone="success" icon={<CircleCheck aria-hidden className="size-3.5" />}>Ready</Badge>
                    : <Badge tone="warn" icon={<CircleDashed aria-hidden className="size-3.5" />}>{set}/{g.items.length} set</Badge>}
                />
                <ul className="divide-y divide-border">
                  {g.items.map((it) => <SetupRow key={it.key} item={it} onSaved={replace} />)}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

function SetupRow({ item, onSaved }: { item: SetupItem; onSaved: (i: SetupItem) => void }) {
  const toast = useToast();
  const [value, setValue] = useState(item.secret ? '' : item.value ?? '');
  const [editing, setEditing] = useState(!item.is_set);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fromEnv = item.source === 'env';
  const locked = !fromEnv && item.editable === false;
  const id = `setup-${item.key}`;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<SetupItem>(`/api/setup/${encodeURIComponent(item.key)}`, { value });
      onSaved(r);
      if (item.secret) setValue('');
      setEditing(false);
      toast.success(`${item.label} saved`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <label htmlFor={id} className="flex items-center gap-2 text-[13px] font-medium">
            {item.secret ? <KeyRound aria-hidden className="size-3.5 text-muted" /> : null}
            {item.label}
          </label>
          <p className="mt-0.5 font-mono text-[11px] text-subtle">{item.key}</p>
          {item.hint ? <p className="mt-1 text-xs text-muted">{item.hint}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {item.is_set
            ? <Badge tone="success" icon={<CircleCheck aria-hidden className="size-3.5" />}>{fromEnv ? 'Set by environment' : 'Set'}</Badge>
            : <Badge tone="warn" icon={<CircleDashed aria-hidden className="size-3.5" />}>Not set</Badge>}
          {item.docs_url ? (
            <a href={item.docs_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline">
              Guide <ExternalLink aria-hidden className="size-3" /><span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </div>
      {item.warning ? <p role="alert" className="rounded-lg border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-warn-soft px-3 py-2 text-xs">{item.warning}</p> : null}
      {locked ? (
        <p className="flex items-center gap-2 text-xs text-muted"><Server aria-hidden className="size-3.5" /> Can only be set through the deployment’s environment variables.</p>
      ) : fromEnv ? (
        <p className="flex items-center gap-2 text-xs text-muted"><Server aria-hidden className="size-3.5" /> Provided by the deployment’s environment variables. Change it there.</p>
      ) : editing ? (
        <div className="flex flex-wrap gap-2">
          <Input
            id={id}
            type={item.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={item.secret ? (item.is_set ? 'Enter a new value to replace the saved one' : 'Paste the value') : ''}
            className="min-w-[240px] flex-1 font-mono text-[13px]"
          />
          <Button variant="primary" onClick={save} loading={busy} disabledReason={!value.trim() ? 'Enter a value.' : null}>Save</Button>
          {item.is_set ? <Button variant="ghost" onClick={() => { setEditing(false); setValue(item.secret ? '' : item.value ?? ''); setError(null); }}>Cancel</Button> : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span id={id} className="font-mono text-[13px] text-muted">{item.secret ? '•••••••• (hidden)' : item.value || '—'}</span>
          <Button size="sm" onClick={() => setEditing(true)}>{item.secret ? 'Replace' : 'Edit'}</Button>
        </div>
      )}
      {error ? <ErrorNotice error={error} /> : null}
    </li>
  );
}
