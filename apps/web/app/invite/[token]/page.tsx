'use client';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ArrowRight, MailCheck } from 'lucide-react';
import { useApi } from '@/lib/client/use-api';
import { ROLE_LABEL } from '@/lib/client/format';
import type { InvitationPreview } from '@/lib/client/types';
import { Banner, ErrorState, Facts, Skeleton, TimeWithZone, TooltipProvider } from '@/components/ui';
import { Logo } from '@/components/shell/logo';

const INVITE_ERRORS: Record<string, string> = {
  email_mismatch: 'You signed in with a different email address from the one invited. Sign in with the invited address.',
  invite_email_mismatch: 'You signed in with a different email address from the one invited. Sign in with the invited address.',
  expired: 'This invitation has expired. Ask the workspace admin to send a new one.',
  invite_expired: 'This invitation has expired. Ask the workspace admin to send a new one.',
  revoked: 'This invitation was revoked.',
  already_accepted: 'This invitation has already been accepted.',
};

export default function InvitePage() {
  return (
    <TooltipProvider>
      <main className="flex min-h-dvh items-start justify-center px-4 py-12 sm:items-center">
        <div className="w-full max-w-[440px]">
          <div className="mb-8"><Logo /></div>
          <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}>
            <Invite />
          </Suspense>
        </div>
      </main>
    </TooltipProvider>
  );
}

function Invite() {
  const { token } = useParams<{ token: string }>();
  const sp = useSearchParams();
  const err = sp.get('error');
  const { data, error, loading, refetch } = useApi<InvitationPreview>(
    token ? `/api/invitations/preview?token=${encodeURIComponent(token)}` : null,
    { redirectOn401: false },
  );
  const usable = data && data.status !== 'expired' && data.status !== 'revoked' && data.status !== 'accepted';
  const signIn = `/api/auth/login?invite=${encodeURIComponent(token ?? '')}&returnTo=${encodeURIComponent('/')}`;

  return (
    <section className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
      <div className="mb-4 flex size-10 items-center justify-center rounded-xl border border-border bg-raised text-accent-text">
        <MailCheck aria-hidden className="size-5" />
      </div>
      {loading ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading invitation">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-4 h-24 w-full" />
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} title="This invitation can’t be shown" />
      ) : data ? (
        <>
          <h1 className="text-[20px] font-semibold">Join {data.workspace_name}</h1>
          <p className="mt-1.5 text-[13px] text-muted">You’ve been invited to collaborate on Social Lite.</p>
          {err ? <Banner tone="danger" className="mt-5" role="alert" title="Couldn’t accept the invitation">{INVITE_ERRORS[err] ?? 'Something went wrong while accepting. Try again.'}</Banner> : null}
          <Facts
            className="mt-6"
            items={[
              ['Role', ROLE_LABEL[data.role] ?? data.role],
              ['Invited email', data.email_hint ?? '—'],
              ['Expires', <TimeWithZone key="e" instant={data.expires_at} tz="UTC" />],
              ['Status', data.status === 'pending' ? 'Pending' : data.status],
            ]}
          />
          {usable ? (
            <>
              <a href={signIn} className="touch-target mt-7 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent text-[15px] font-medium text-on-accent hover:bg-accent-hover">
                Sign in to accept <ArrowRight aria-hidden className="size-4" />
              </a>
              <p className="mt-3 text-xs text-muted">Sign in with the invited email address. The invitation is bound to it.</p>
            </>
          ) : (
            <Banner tone="warn" className="mt-6" title="This invitation can no longer be used">
              Ask the person who invited you to send a new invitation.
            </Banner>
          )}
        </>
      ) : null}
    </section>
  );
}
