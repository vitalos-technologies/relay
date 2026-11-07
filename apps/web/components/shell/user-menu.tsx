'use client';
import { useEffect, useState } from 'react';
import { LogOut, Monitor, Moon, ShieldCheck, Sun, UserRound } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { applyTheme, currentTheme, type Theme } from '@/lib/client/theme';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, useToast } from '@/components/ui';

export function UserMenu({ compact }: { compact?: boolean }) {
  const { session } = useSession();
  const toast = useToast();
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    setTheme(currentTheme());
  }, []);
  const u = session.user;
  const initials = (u.name || u.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('');

  const signOut = async () => {
    let next = '/login';
    try {
      const r = await api.post<{ logout_url?: string | null }>('/api/auth/logout', {});
      // Also end the identity-provider session (RP-initiated logout); it returns to /login.
      if (r?.logout_url) next = r.logout_url;
    } catch (e) {
      toast.error(e, 'Sign out failed');
      return;
    }
    window.location.assign(next);
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
        <MenuItem icon={<UserRound aria-hidden />} onSelect={() => window.location.assign('/settings/personal/profile')}>Profile and settings</MenuItem>
        <MenuItem icon={<ShieldCheck aria-hidden />} onSelect={() => window.location.assign('/security')}>Security</MenuItem>
        <MenuItem icon={<LogOut aria-hidden />} onSelect={() => void signOut()}>Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
}
