'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { api } from '@/lib/client/api';
import { SessionProvider, useSession } from '@/lib/client/session';
import { allTimeZones, ROLE_LABEL } from '@/lib/client/format';
import type { SessionInfo } from '@/lib/client/types';
import { Button, ErrorNotice, ErrorState, Field, Input, Select, Spinner } from '@/components/ui';
import { Logo } from '@/components/shell/logo';

export default function OnboardingPage() {
  return (
    <main className="flex min-h-dvh items-start justify-center px-4 py-12 sm:items-center">
      <div className="w-full max-w-[460px]">
        <div className="mb-8"><Logo /></div>
        <SessionProvider
          requireWorkspace={false}
          fallback={<Spinner label="Loading your account" />}
          renderError={(e, retry) => <ErrorState error={e} onRetry={retry} />}
        >
          <Onboarding />
        </SessionProvider>
      </div>
    </main>
  );
}

function Onboarding() {
  const { session } = useSession();
  const creatingAnother = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('new');
  const [mode, setMode] = useState<'create' | 'pick'>(!creatingAnother && session.workspaces.length > 0 ? 'pick' : 'create');
  if (mode === 'create' && session.can_create_workspace === false) {
    return (
      <section className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
        <h1 className="text-[22px] font-semibold">No workspace yet</h1>
        <p className="mt-2 truncate text-[13px] text-muted">{session.user.email} · ask an admin to invite you</p>
      </section>
    );
  }
  return mode === 'pick'
    ? <PickWorkspace session={session} onCreate={session.can_create_workspace === false ? null : () => setMode('create')} />
    : <CreateWorkspace firstTime={session.workspaces.length === 0} />;
}

function PickWorkspace({ session, onCreate }: { session: SessionInfo; onCreate: (() => void) | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pick = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.post('/api/session/workspace', { workspace_id: id });
      window.location.assign('/');
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  };
  return (
    <section className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
      <h1 className="text-[22px] font-semibold">Choose a workspace</h1>
      <p className="mt-1 truncate text-[13px] text-muted">{session.user.email}</p>
      <ul className="mt-6 flex flex-col gap-2">
        {session.workspaces.map((w) => (
          <li key={w.id}>
            <button
              type="button"
              onClick={() => void pick(w.id)}
              disabled={!!busy}
              className="flex h-14 w-full items-center justify-between rounded-lg border border-border px-4 text-left hover:bg-raised"
            >
              <span>
                <span className="block text-sm font-medium">{w.name}</span>
                <span className="block text-xs text-muted">{ROLE_LABEL[w.role]}{w.is_demo ? ' · Demo' : ''}</span>
              </span>
              {busy === w.id ? <Spinner label="Opening" /> : <ArrowRight aria-hidden className="size-4 text-muted" />}
            </button>
          </li>
        ))}
      </ul>
      {error ? <ErrorNotice error={error} className="mt-4" /> : null}
      {onCreate ? <Button variant="ghost" className="mt-4" onClick={onCreate}>New workspace</Button> : null}
    </section>
  );
}

function CreateWorkspace({ firstTime }: { firstTime: boolean }) {
  const zones = useMemo(() => allTimeZones(), []);
  const [name, setName] = useState('');
  const [tz, setTz] = useState('Europe/London');
  const [brandName, setBrandName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFieldError('Enter a name.');
      return;
    }
    setFieldError(null);
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id?: string; workspace?: { id: string }; brand?: { id: string } | null }>(
        '/api/workspaces',
        { name: name.trim(), timezone: tz, ...(brandName.trim() ? { brand_name: brandName.trim() } : {}) },
        { idempotent: true },
      );
      const id = created?.id ?? created?.workspace?.id;
      if (id) {
        try {
          await api.post('/api/session/workspace', { workspace_id: id });
        } catch {
          /* the server may already have activated it */
        }
      }
      // With a first brand the next step is connecting accounts; otherwise create a brand.
      window.location.assign(created?.brand?.id ? `/accounts?brand=${created.brand.id}` : '/settings/workspace/branding');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
      <h1 className="text-[22px] font-semibold">{firstTime ? 'Create your workspace' : 'Create a workspace'}</h1>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-5" noValidate>
        <Field label="Workspace name" error={fieldError}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="organization" maxLength={120} autoFocus placeholder="Northwind Studio" />
        </Field>
        <Field label="First brand" optional>
          <Input value={brandName} onChange={(e) => setBrandName(e.target.value)} maxLength={120} placeholder="Northwind Coffee" />
        </Field>
        <Field label="Time zone">
          <Select value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </Select>
        </Field>
        {error ? <ErrorNotice error={error} /> : null}
        <Button type="submit" variant="primary" size="lg" loading={busy}>Create</Button>
      </form>
    </section>
  );
}
