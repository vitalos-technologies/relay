'use client';
import { useState } from 'react';
import { Check, ChevronsUpDown, FlaskConical } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { ROLE_LABEL } from '@/lib/client/format';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, useToast } from '@/components/ui';

export function WorkspaceSwitcher() {
  const { session } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const ws = session.workspace;
  if (!ws) return null;

  const switchTo = async (id: string) => {
    if (id === ws.id) return;
    setBusy(true);
    try {
      await api.post('/api/session/workspace', { workspace_id: id });
      window.location.assign('/');
    } catch (e) {
      toast.error(e, 'Could not switch workspace');
      setBusy(false);
    }
  };

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          className="flex h-11 w-full items-center gap-2.5 rounded-lg border border-border bg-raised px-2.5 text-left hover:border-border-strong"
          aria-label={`Workspace: ${ws.name}. Switch workspace`}
        >
          <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sunken text-xs font-semibold uppercase text-muted">
            {ws.name.slice(0, 2)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{ws.name}</span>
            <span className="block truncate text-[11px] text-muted">{ROLE_LABEL[ws.role]}{ws.is_demo ? ' · Demo' : ''}</span>
          </span>
          <ChevronsUpDown aria-hidden className="size-4 text-muted" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="w-[260px]">
        <MenuLabel>Workspaces</MenuLabel>
        {session.workspaces.map((w) => (
          <MenuItem key={w.id} onSelect={() => void switchTo(w.id)} icon={w.id === ws.id ? <Check aria-hidden /> : <span className="size-4" />}>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate">{w.name}</span>
              {w.is_demo ? <FlaskConical aria-label="Demo" className="size-3.5 text-accent-text" /> : null}
            </span>
            <span className="text-[11px] text-muted">{ROLE_LABEL[w.role]}</span>
          </MenuItem>
        ))}
        {session.can_create_workspace ? (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => window.location.assign('/onboarding?new=1')}>Create a workspace…</MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}
