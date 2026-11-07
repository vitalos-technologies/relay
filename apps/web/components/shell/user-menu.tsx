'use client';
import { useEffect, useState } from 'react';
import { LifeBuoy, LogOut, Monitor, Moon, ShieldCheck, Sparkles, Sun, UserRound } from 'lucide-react';
import { useFlag } from '@/lib/client/flags';
import { ReportProblemDialog, WhatsNewDrawer, useReleaseNotes } from '@/components/support/support';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { applyTheme, currentTheme, type Theme } from '@/lib/client/theme';
import { clearNamespace } from '@/lib/client/draft-recovery';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, useToast } from '@/components/ui';

export function UserMenu({ compact }: { compact?: boolean }) {
  const { session } = useSession();
  const toast = useToast();
  const [theme, setTheme] = useState<Theme>('system');
  const notesOn = useFlag('v31.release_notes');
  const notes = useReleaseNotes(notesOn);
  const [notesOpen, setNotesOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const unseen = notesOn ? notes.data?.unseen ?? 0 : 0;
  useEffect(() => {
    setTheme(currentTheme());
  }, []);
  const u = session.user;
  const initials = (u.name || u.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('');

  const signOut = async () => {
    let next = '/login';
    // Workspace policy: browser copies of drafts don't outlive the session.
    if (session.draft_recovery?.clear_on_logout) clearNamespace(session.draft_recovery);
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
          aria-label={`Account menu for ${u.name || u.email}${unseen ? `, ${unseen} new release note${unseen === 1 ? '' : 's'}` : ''}`}
          className={compact
            ? 'touch-target inline-flex size-9 items-center justify-center rounded-full'
            : 'flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 text-left hover:bg-raised'}
        >
          <span aria-hidden className="relative flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-raised text-[11px] font-semibold">
            {initials || '?'}
            {unseen ? <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-[var(--bg)] bg-accent" /> : null}
          </span>
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
        <MenuSeparator />
        {notesOn ? (
          <MenuItem icon={<Sparkles aria-hidden />} onSelect={() => setNotesOpen(true)}>
            <span className="flex-1">What’s new</span>{unseen ? <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-on-accent tabular">{unseen}</span> : null}
          </MenuItem>
        ) : null}
        <MenuItem icon={<LifeBuoy aria-hidden />} onSelect={() => setReportOpen(true)}>Report a problem</MenuItem>
        <MenuSeparator />
        <MenuItem icon={<LogOut aria-hidden />} onSelect={() => void signOut()}>Sign out</MenuItem>
      </MenuContent>
      {notesOn ? <WhatsNewDrawer open={notesOpen} onOpenChange={setNotesOpen} notes={notes.data} onSeen={(r) => notes.setData(r)} /> : null}
      <ReportProblemDialog open={reportOpen} onOpenChange={setReportOpen} />
    </Menu>
  );
}
