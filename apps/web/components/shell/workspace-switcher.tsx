'use client';
import { useState } from 'react';
import { Check, ChevronsUpDown, FlaskConical } from 'lucide-react';
import { api } from '@/lib/client/api';
import { enterWorkspace } from '@/lib/client/workspace-sync';
import { useSession } from '@/lib/client/session';
import { ROLE_LABEL } from '@/lib/client/format';
import { V2_ROLE_LABEL } from '@/components/team/shared';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, useToast } from '@/components/ui';

export function WorkspaceSwitcher({ compact }: { compact?: boolean }) {
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
      // Drop every cache from the previous workspace (memory, storage, other tabs), then hard-reload.
      enterWorkspace(id);
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
          className={compact ? 'flex h-11 w-full items-center justify-center rounded-lg hover:bg-raised' : 'flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-raised'}
          aria-label={`Workspace: ${ws.name}. Switch workspace`}
        >
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-tile text-xs font-semibold uppercase text-tile-fg">
            {ws.name.slice(0, 2)}
          </span>
          {compact ? null : <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{ws.name}</span>
            <span className="block truncate text-[11px] text-muted">{(ws.primary_role && V2_ROLE_LABEL[ws.primary_role]) || ROLE_LABEL[ws.role]}{ws.is_demo ? ' · Demo' : ''}</span>
          </span>
          <ChevronsUpDown aria-hidden className="size-4 text-muted" />
          </>}
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="w-[260px]">
        <MenuLabel>Workspaces</MenuLabel>
        {session.workspaces.map((w) => (
          <MenuItem key={w.id} onSelect={() => void switchTo(w.id)} icon={w.id === ws.id ? <Check aria-hidden /> : <span className="size-4" />}>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate">{w.name}</span>
              {w.is_demo ? <FlaskConical aria-label="Demo" className="size-3.5 text-muted" /> : null}
            </span>
            <span className="text-[11px] text-muted">{ROLE_LABEL[w.role]}</span>
          </MenuItem>
        ))}
        {session.can_create_workspace ? (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => window.location.assign('/onboarding?new=1')}>New workspace…</MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}
