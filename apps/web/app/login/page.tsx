import type { Metadata } from 'next';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { safeReturnTo } from '@/lib/client/api';
import { PlatformIcon } from '@/components/ui/platform-icon';

export const metadata: Metadata = { title: 'Sign in' };

const ERRORS: Record<string, string> = {
  access_denied: 'Sign-in was cancelled. You can try again when you’re ready.',
  state_mismatch: 'That sign-in link expired or was already used. Start again.',
  invalid_state: 'That sign-in link expired or was already used. Start again.',
  no_workspace: 'Your account isn’t a member of any workspace yet. Ask an admin for an invitation.',
  invite_email_mismatch: 'This invitation was sent to a different email address. Sign in with the invited address.',
  invite_expired: 'This invitation has expired. Ask the workspace admin for a new one.',
  oidc_error: 'The identity provider returned an error. Try again, or contact your administrator.',
  session_expired: 'Your session ended. Sign in again to continue.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const returnTo = safeReturnTo(one(sp.returnTo));
  const error = one(sp.error);
  const href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  const message = error ? (ERRORS[error] ?? 'Sign-in failed. Try again, or contact your administrator.') : null;

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute inset-0 [background:radial-gradient(600px_300px_at_50%_-10%,var(--accent-soft),transparent_70%)]" />
      <div className="relative w-full max-w-[400px]">
        <div className="mb-8 flex items-center gap-2.5">
          <span aria-hidden className="inline-flex size-9 items-center justify-center rounded-xl border border-border bg-raised">
            <span className="size-3 rounded-full bg-accent shadow-[0_0_14px_var(--accent)]" />
          </span>
          <span className="text-lg font-semibold tracking-[-0.01em]">Social Lite</span>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-6 shadow-[var(--shadow)] sm:p-8">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Sign in</h1>
          <p className="mt-1.5 text-[13px] text-muted">
            Plan, approve and publish to every channel from one calm place.
          </p>

          {message ? (
            <div role="alert" className="mt-5 rounded-lg border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-danger-soft px-3.5 py-3 text-[13px]">
              <p className="font-medium">Couldn’t sign you in</p>
              <p className="mt-0.5 text-muted">{message}</p>
              {error ? <p className="mt-1 font-mono text-[11px] text-subtle">Code: {error}</p> : null}
            </div>
          ) : null}

          <a
            href={href}
            className="touch-target mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent text-[15px] font-medium text-on-accent hover:bg-accent-hover"
          >
            Continue with single sign-on
            <ArrowRight aria-hidden className="size-4" />
          </a>

          <p className="mt-4 flex items-start gap-2 text-xs text-muted">
            <ShieldCheck aria-hidden className="mt-px size-3.5 shrink-0 text-success" />
            You’ll be sent to your organisation’s identity provider. Social Lite never sees your password.
          </p>
        </div>

        <div className="mt-8 flex items-center gap-2" role="group" aria-label="Supported networks">
          <PlatformIcon provider="instagram" size="sm" />
          <PlatformIcon provider="facebook" size="sm" />
          <PlatformIcon provider="telegram" size="sm" />
          <PlatformIcon provider="x" size="sm" />
          <span className="ml-2 text-xs text-subtle">Instagram, Facebook, Telegram and X</span>
        </div>
      </div>
    </main>
  );
}
