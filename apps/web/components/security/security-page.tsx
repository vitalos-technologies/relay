'use client';
// My Security: two-step verification (TOTP, passkeys, recovery codes — all managed by the identity provider),
// this session's assurance, active sessions and recent security events. Every action is server-side:
// factor changes run as Keycloak application-initiated actions for the signed-in user; removal and regeneration
// require a fresh verification (step-up). Nothing here can change another user's factors.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Fingerprint, KeyRound, LifeBuoy, LogOut, MonitorSmartphone, ShieldCheck, ShieldAlert, Smartphone } from 'lucide-react';
import { api, isApiError, stepUpHref } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative, plural } from '@/lib/client/format';
import { useBrowserTimeZone } from '@/lib/client/hooks';
import {
  Badge, Banner, Button, Card, CardHeader, ConfirmDialog, ErrorState, InfoTip, PageHeader, SkeletonRows, TimeWithZone, useToast,
} from '@/components/ui';
import { HelpLink } from '@/components/help/help-link';

interface Credential { id: string; type: string; label: string | null; created_at: string | null }
interface SessionView { id: string; current: boolean; created_at: string; last_seen_at: string; expires_at: string; user_agent: string | null; mfa_verified: boolean; acr: string | null; amr: string[]; auth_time: string | null }
interface Overview {
  assurance: { mfa_verified: boolean; acr: string | null; amr: string[]; auth_time: string | null; fresh_until: string | null; fresh: boolean };
  mfa_required: boolean;
  factors: { available: boolean; totp: Credential[]; passkeys: Credential[]; recovery_codes: Credential | null };
  sessions: SessionView[];
  events: Array<{ id: string; action: string; at: string; detail: Record<string, unknown> }>;
}

type FactorAction = 'CONFIGURE_TOTP' | 'webauthn-register' | 'CONFIGURE_RECOVERY_AUTHN_CODES' | 'delete_credential';

/** Coarse device label from the user agent (no fingerprinting, no location). */
export function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /vitest|node|curl/i.test(ua) ? 'Script' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

const EVENT_LABEL: Record<string, string> = {
  'user.login': 'Signed in', 'user.created': 'Account created', 'user.bound': 'Account linked',
  'auth.step_up': 'Verified', 'auth.step_up_cancelled': 'Verification cancelled', 'auth.step_up_subject_mismatch': 'Verification by another account refused',
  'auth.factor_action': 'Sign-in method changed', 'auth.factor_action_started': 'Sign-in method change started', 'auth.factor_action_cancelled': 'Sign-in method change cancelled',
  'auth.recovery_code_used': 'Recovery code used · other sessions signed out', 'auth.factor_changed_followup': 'Other sessions signed out',
  'session.revoked': 'Session signed out', 'session.revoked_others': 'Other sessions signed out', 'session.signed_out': 'Signed out', 'session.idp_logout': 'Signed out by identity provider',
};
const ACTION_LABEL: Record<string, string> = {
  CONFIGURE_TOTP: 'authenticator app', 'webauthn-register': 'passkey', CONFIGURE_RECOVERY_AUTHN_CODES: 'recovery codes', fresh: '', mfa: '',
};

function eventText(e: Overview['events'][number]): string {
  const a = typeof e.detail.action === 'string' ? e.detail.action : '';
  const base = e.action === 'auth.step_up' && a === 'mfa' ? 'Second factor at sign-in' : EVENT_LABEL[e.action] ?? e.action;
  const what = a.startsWith('delete_credential') ? 'removed' : ACTION_LABEL[a] ?? '';
  const mfa = 'mfa' in e.detail && (e.action === 'user.login' || e.action === 'user.bound' || e.action === 'auth.step_up') ? (e.detail.mfa ? ' · two-step' : ' · password') : '';
  return `${base}${what ? ` · ${what}` : ''}${mfa}`;
}

export function SecurityPage() {
  const toast = useToast();
  const params = useSearchParams();
  const tz = useBrowserTimeZone() || 'UTC';
  const { data, error, loading, refetch } = useApi<Overview>('/api/security');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; label: string; run: () => Promise<unknown> }>(null);
  const verified = params.get('verified');
  const setup = params.get('setup');

  useEffect(() => {
    if (verified === '1') toast.success('Verified');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verified]);

  const startAction = async (action: FactorAction, credentialId?: string) => {
    setBusy(`${action}:${credentialId ?? ''}`);
    try {
      const r = await api.post<{ redirect_url: string }>('/api/security/factors', { action, credential_id: credentialId ?? null });
      window.location.assign(r.redirect_url);
    } catch (e) {
      setBusy(null);
      if (!(isApiError(e) && e.code === 'step_up_required')) toast.error(e, 'Couldn’t start');
    }
  };

  const revoke = async (id: string, current: boolean) => {
    await api.del(`/api/security/sessions/${id}`);
    // Full page load on purpose: this device's session is gone, drop all client state.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (current) { window.location.assign('/login'); return; }
    toast.success('Signed out');
    await refetch();
  };

  if (loading && !data) return (<><PageHeader title="Security" /><SkeletonRows rows={6} /></>);
  if (error && !data) return (<><PageHeader title="Security" /><ErrorState error={error} onRetry={() => void refetch()} /></>);
  if (!data) return null;

  const f = data.factors;
  const hasFactor = f.totp.length > 0 || f.passkeys.length > 0 || !!f.recovery_codes;
  const a = data.assurance;

  return (
    <>
      <PageHeader
        title="Security"
        meta={a.mfa_verified ? <><ShieldCheck aria-hidden className="size-3.5 text-success" />Two-step verified</> : <><ShieldAlert aria-hidden className="size-3.5" />Password only</>}
        actions={<><HelpLink slug="set-up-two-step-verification" label="About two-step verification" /><a className="touch-target inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3.5 text-sm font-medium hover:bg-raised" href={stepUpHref('/security')} data-testid="verify-now"><KeyRound aria-hidden className="size-4" />Verify now</a></>}
      />
      <div className="flex flex-col gap-6">
        {verified === '0' ? <Banner tone="warn" title="Not changed">Verification was cancelled.</Banner> : null}
        {data.mfa_required && !hasFactor ? (
          <Banner tone="warn" role="alert" title="Two-step verification required" actions={<Button variant="primary" size="sm" onClick={() => void startAction('CONFIGURE_TOTP')} loading={busy === 'CONFIGURE_TOTP:'}>Set up</Button>}>
            Sensitive actions stay unavailable until you set it up.
          </Banner>
        ) : setup === 'mfa' && !hasFactor ? (
          <Banner tone="info" title="Set up two-step verification first" />
        ) : null}
        {!f.available ? <Banner tone="warn" title="Sign-in methods unavailable">Couldn’t reach the sign-in provider. Try again later.</Banner> : null}

        <Card aria-labelledby="mfa-h">
          <CardHeader id="mfa-h" title={<span className="inline-flex items-center gap-2">Two-step verification <InfoTip label="About two-step verification">Managed by the identity provider. Removing a method or regenerating codes asks you to verify again.</InfoTip></span>} />
          <ul className="divide-y divide-border px-4 pb-2">
            <FactorRow icon={<Smartphone aria-hidden className="size-4" />} name="Authenticator app" testId="factor-totp"
              items={f.totp} onRemove={(c) => setConfirm({ title: 'Remove authenticator app?', label: 'Remove', run: () => startAction('delete_credential', c.id) })}
              add={<Button size="sm" variant={hasFactor ? 'secondary' : 'primary'} disabled={!f.available} loading={busy === 'CONFIGURE_TOTP:'} onClick={() => void startAction('CONFIGURE_TOTP')} data-testid="add-totp">{f.totp.length ? 'Add another' : 'Set up'}</Button>} />
            <FactorRow icon={<Fingerprint aria-hidden className="size-4" />} name="Passkeys" testId="factor-passkeys"
              items={f.passkeys} onRemove={(c) => setConfirm({ title: 'Remove passkey?', label: 'Remove', run: () => startAction('delete_credential', c.id) })}
              add={<Button size="sm" disabled={!f.available} loading={busy === 'webauthn-register:'} onClick={() => void startAction('webauthn-register')} data-testid="add-passkey">Add</Button>} />
            <li className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="factor-recovery">
              <div className="flex min-w-0 items-center gap-3">
                <LifeBuoy aria-hidden className="size-4 text-muted" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Recovery codes</p>
                  <p className="text-xs text-muted">{f.recovery_codes ? <>Set {f.recovery_codes.created_at ? fmtRelative(f.recovery_codes.created_at) : ''}</> : 'Not set'}</p>
                </div>
              </div>
              <div className="flex gap-2">
                {f.recovery_codes ? (
                  <>
                    <Button size="sm" disabled={!f.available} onClick={() => setConfirm({ title: 'Regenerate recovery codes?', label: 'Regenerate', run: () => startAction('CONFIGURE_RECOVERY_AUTHN_CODES') })} data-testid="regen-codes">Regenerate</Button>
                    <Button size="sm" variant="quiet" onClick={() => setConfirm({ title: 'Remove recovery codes?', label: 'Remove', run: () => startAction('delete_credential', f.recovery_codes!.id) })} data-testid="remove-codes">Remove</Button>
                  </>
                ) : (
                  <Button size="sm" disabled={!f.available || !hasFactor} disabledReason={!hasFactor ? 'Set up an authenticator app or passkey first' : null}
                    loading={busy === 'CONFIGURE_RECOVERY_AUTHN_CODES:'} onClick={() => void startAction('CONFIGURE_RECOVERY_AUTHN_CODES')} data-testid="add-codes">Generate</Button>
                )}
              </div>
            </li>
          </ul>
        </Card>

        <Card aria-labelledby="sess-h">
          <CardHeader id="sess-h" title="Sessions" actions={data.sessions.length > 1 ? (
            <Button size="sm" variant="secondary" icon={<LogOut aria-hidden className="size-4" />} data-testid="revoke-others"
              onClick={() => setConfirm({ title: 'Sign out all other sessions?', label: 'Sign out others', run: async () => { const r = await api.post<{ revoked: number }>('/api/security/sessions/revoke-others', {}); toast.success(`${plural(r.revoked, 'session')} signed out`); await refetch(); } })}>Sign out others</Button>
          ) : null} />
          <ul className="divide-y divide-border px-4 pb-2" data-testid="session-list">
            {data.sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-session-id={s.id}>
                <div className="flex min-w-0 items-center gap-3">
                  <MonitorSmartphone aria-hidden className="size-4 text-muted" />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{deviceLabel(s.user_agent)}{s.current ? <Badge tone="accent">This device</Badge> : null}{s.mfa_verified ? <Badge tone="success">Two-step</Badge> : null}</p>
                    <p className="text-xs text-muted">Active {fmtRelative(s.last_seen_at)} · signed in <TimeWithZone instant={s.created_at} tz={tz} /></p>
                  </div>
                </div>
                <Button size="sm" variant={s.current ? 'quiet' : 'secondary'} onClick={() => setConfirm({ title: s.current ? 'Sign out this device?' : 'Sign out this session?', label: 'Sign out', run: () => revoke(s.id, s.current) })}>Sign out</Button>
              </li>
            ))}
          </ul>
        </Card>

        <Card aria-labelledby="ev-h">
          <CardHeader id="ev-h" title="Recent activity" actions={a.auth_time ? <span className="text-xs text-muted">{a.fresh ? 'Verified recently' : `Signed in ${fmtRelative(a.auth_time)}`}</span> : null} />
          {data.events.length ? (
            <ul className="divide-y divide-border px-4 pb-2" data-testid="security-events">
              {data.events.slice(0, 12).map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <span>{eventText(e)}</span>
                  <span className="text-xs text-muted"><TimeWithZone instant={e.at} tz={tz} /></span>
                </li>
              ))}
            </ul>
          ) : <p className="px-4 pb-4 text-sm text-muted">No activity yet</p>}
        </Card>
      </div>
      {confirm ? (
        <ConfirmDialog open onOpenChange={(o) => { if (!o) setConfirm(null); }} title={confirm.title} confirmLabel={confirm.label} confirmVariant="danger" onConfirm={confirm.run} />
      ) : null}
    </>
  );
}

function FactorRow({ icon, name, items, add, onRemove, testId }: { icon: React.ReactNode; name: string; items: Credential[]; add: React.ReactNode; onRemove: (c: Credential) => void; testId: string }) {
  return (
    <li className="py-3" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-muted">{icon}</span>
          <div className="min-w-0">
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-muted">{items.length ? `${items.length} active` : 'Not set'}</p>
          </div>
        </div>
        {add}
      </div>
      {items.length ? (
        <ul className="mt-2 flex flex-col gap-1 pl-7">
          {items.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 rounded-lg bg-raised px-3 py-1.5 text-[13px]">
              <span className="truncate">{c.label || name}{c.created_at ? <span className="text-muted"> · {fmtRelative(c.created_at)}</span> : null}</span>
              <Button size="sm" variant="quiet" onClick={() => onRemove(c)} aria-label={`Remove ${c.label || name}`}>Remove</Button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
