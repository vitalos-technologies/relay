'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Plug } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import type { Connection, ConnectionFlow, DestinationCandidate } from '@/lib/client/types';
import { Button, Card, Checkbox, EmptyState, ErrorNotice, ErrorState, LinkButton, PageHeader, PlatformIcon, SkeletonRows, TimeWithZone } from '@/components/ui';

const idOf = (c: DestinationCandidate) => c.providerAccountId ?? c.provider_account_id ?? '';
const nameOf = (c: DestinationCandidate) => c.displayName ?? c.display_name ?? idOf(c);
const reasonOf = (c: DestinationCandidate) => c.unavailableReason ?? c.unavailable_reason ?? null;

/** AC-02: after OAuth, the user explicitly chooses which destinations to add. Nothing is imported automatically. */
export default function SelectDestinationsPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const { session } = useSession();
  const flow = sp.get('flow');
  const { data, error, loading, refetch } = useApi<ConnectionFlow>(flow ? `/api/connection-flows/${encodeURIComponent(flow)}` : null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);

  if (!flow) {
    return <><PageHeader title="Choose destinations" /><EmptyState icon={<Plug aria-hidden />} title="No connection in progress" action={<LinkButton href="/accounts" variant="primary">Go to Accounts</LinkButton>}>Start connecting from the Accounts page.</EmptyState></>;
  }
  const brandName = data ? session.brands.find((b) => b.id === data.brand_id)?.name : undefined;
  const expired = data && new Date(data.expires_at).getTime() < Date.now();

  const submit = async () => {
    setBusy(true);
    setSubmitError(null);
    try {
      const r = await api.post<{ items: Connection[] }>(`/api/connection-flows/${encodeURIComponent(flow)}/select`, { provider_account_ids: picked });
      router.replace(`/accounts?brand=${data?.brand_id ?? ''}&connected=${r.items.length}`);
    } catch (e) {
      setSubmitError(e);
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={data ? `Choose ${PROVIDER_LABEL[data.provider]} destinations` : 'Choose destinations'}
        description={data ? <>Select exactly which ones to add{brandName ? <> to <span className="text-fg">{brandName}</span></> : null}. Nothing is added unless you tick it.</> : undefined}
      />
      {error && !data ? <ErrorState error={error} onRetry={refetch} title="This connection link can’t be used" /> : loading || !data ? <SkeletonRows rows={3} /> : (
        <Card className="max-w-2xl">
          <div className="p-5">
            {expired ? <ErrorNotice error={new Error('This selection expired. Start connecting again from Accounts.')} className="mb-4" /> : (
              <p className="mb-4 text-xs text-muted">Selection expires <TimeWithZone instant={data.expires_at} tz={session.workspace?.timezone ?? 'UTC'} format="time" />.</p>
            )}
            {!data.candidates.length ? (
              <EmptyState compact title="Nothing available to add">The account you authorised has no pages or profiles you can publish to.</EmptyState>
            ) : (
              <fieldset>
                <legend className="sr-only">Destinations</legend>
                <ul className="flex flex-col gap-2">
                  {data.candidates.map((c) => {
                    const id = idOf(c);
                    const reason = reasonOf(c);
                    return (
                      <li key={id} className="flex items-start gap-3 rounded-lg border border-border px-3 py-3">
                        <PlatformIcon provider={c.provider} size="sm" />
                        <Checkbox
                          className="flex-1"
                          checked={picked.includes(id)}
                          disabled={!!reason || !!expired}
                          onChange={(e) => setPicked((p) => (e.target.checked ? [...p, id] : p.filter((x) => x !== id)))}
                          label={<span className="font-medium">{nameOf(c)}</span>}
                          description={reason ? `Unavailable: ${reason}` : `${c.username ? `@${c.username.replace(/^@/, '')} · ` : ''}ID ${id}`}
                        />
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            )}
            {submitError ? <ErrorNotice error={submitError} className="mt-4" /> : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <LinkButton href="/accounts" variant="ghost">Cancel</LinkButton>
              <Button variant="primary" onClick={submit} loading={busy} disabledReason={!picked.length ? 'Tick at least one destination.' : expired ? 'This selection expired.' : null}>
                Add {picked.length || ''} destination{picked.length === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
