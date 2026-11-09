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
  email_mismatch: 'Sign in with the invited email.',
  invite_email_mismatch: 'Sign in with the invited email.',
  expired: 'Expired. Ask for a new one.',
  invite_expired: 'Expired. Ask for a new one.',
  revoked: 'Revoked.',
  already_accepted: 'Already accepted.',
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
  const signIn = `/api/auth/login?invite=${encodeURIComponent(token ?? '')}&returnTo=${encodeURIComponent('/overview')}`;

  return (
    <section className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
      <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-raised text-muted">
        <MailCheck aria-hidden className="size-5" />
      </div>
      {loading ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading invitation">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-4 h-24 w-full" />
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} title="Invitation unavailable" />
      ) : data ? (
        <>
          <h1 className="text-[20px] font-semibold">Join {data.workspace_name}</h1>
          {err ? <Banner tone="danger" className="mt-5" role="alert" title="Couldn’t accept">{INVITE_ERRORS[err] ?? 'Try again.'}</Banner> : null}
          <Facts
            className="mt-6"
            items={[
              ['Role', ROLE_LABEL[data.role] ?? data.role],
              ['Invited email', data.email_hint ?? '—'],
              ['Expires', <TimeWithZone key="e" instant={data.expires_at} tz="UTC" />],
            ]}
          />
          {usable ? (
            <>
              <a href={signIn} className="touch-target mt-7 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent text-[15px] font-medium text-on-accent hover:bg-accent-hover">
                Accept <ArrowRight aria-hidden className="size-4" />
              </a>
              <p className="mt-3 text-xs text-muted">Use the invited email.</p>
            </>
          ) : (
            <Banner tone="warn" className="mt-6" title="No longer valid — ask for a new one" />
          )}
        </>
      ) : null}
    </section>
  );
}
