'use client';
import { useEffect, useState } from 'react';
import { LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, useToast } from '@/components/ui';

type Theme = 'system' | 'light' | 'dark';

function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', t);
  try {
    if (t === 'system') localStorage.removeItem('sl-theme');
    else localStorage.setItem('sl-theme', t);
  } catch {
    /* storage unavailable */
  }
}

export function UserMenu({ compact }: { compact?: boolean }) {
  const { session } = useSession();
  const toast = useToast();
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    const a = document.documentElement.getAttribute('data-theme');
    setTheme(a === 'light' || a === 'dark' ? a : 'system');
  }, []);
  const u = session.user;
  const initials = (u.name || u.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('');

  const signOut = async () => {
    try {
      await api.post('/api/auth/logout', {});
    } catch (e) {
      toast.error(e, 'Sign out failed');
      return;
    }
    window.location.assign('/login');
  };

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${u.name || u.email}`}
          className={compact
            ? 'touch-target inline-flex size-9 items-center justify-center rounded-full'
            : 'flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 text-left hover:bg-raised'}
        >
          <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-raised text-[11px] font-semibold">{initials || '?'}</span>
          {compact ? null : (
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium">{u.name || u.email}</span>
              {u.name ? <span className="block truncate text-[11px] text-muted">{u.email}</span> : null}
            </span>
          )}
        </button>
      </MenuTrigger>
      <MenuContent align={compact ? 'end' : 'start'} className="w-[240px]">
        <MenuLabel>Appearance</MenuLabel>
        <MenuRadioGroup value={theme} onValueChange={(v) => { const t = v as Theme; setTheme(t); applyTheme(t); }}>
          <MenuRadioItem value="system" icon={<Monitor aria-hidden />}>System</MenuRadioItem>
          <MenuRadioItem value="dark" icon={<Moon aria-hidden />}>Dark</MenuRadioItem>
          <MenuRadioItem value="light" icon={<Sun aria-hidden />}>Light</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem icon={<LogOut aria-hidden />} onSelect={() => void signOut()}>Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
}
