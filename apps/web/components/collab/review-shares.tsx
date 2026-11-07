'use client';
import { useState } from 'react';
import { UserPlus, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Button, ErrorNotice, IconButton, Select, Skeleton, TimeWithZone, useToast } from '@/components/ui';

interface Shares {
  items: Array<{ user_id: string; email: string; name: string | null; access_expires_at: string | null }>;
  candidates: Array<{ user_id: string; email: string; name: string | null; access_expires_at: string }>; can_share: boolean;
}

/** Share a post's review with client guests of the brand (they see only this review in the portal). */
export function ReviewShares({ postId }: { postId: string }) {
  const toast = useToast();
  const { data, error, refetch } = useApi<Shares>(`/api/posts/${postId}/review-shares`);
  const [pick, setPick] = useState('');
  const [err, setErr] = useState<unknown>(null);
  if (error && !data) return <ErrorNotice error={error} />;
  if (!data) return <Skeleton className="h-16 w-full rounded-lg" />;
  return (
    <div className="flex flex-col gap-2">
      {data.items.length ? (
        <ul className="flex flex-col gap-1" aria-label="Shared with">
          {data.items.map((s) => (
            <li key={s.user_id} className="flex items-center gap-2 text-[13px]">
              <span className="min-w-0 flex-1 truncate">{s.name || s.email}</span>
              {s.access_expires_at ? <span className="text-[11px] text-subtle">until <TimeWithZone instant={s.access_expires_at} tz="UTC" /></span> : null}
              {data.can_share ? <IconButton size="sm" label={`Stop sharing with ${s.email}`} icon={<X aria-hidden className="size-3.5" />}
                onClick={async () => { await api.del(`/api/posts/${postId}/review-shares/${s.user_id}`); toast.success('Access removed'); await refetch(); }} /> : null}
            </li>
          ))}
        </ul>
      ) : <p className="text-[13px] text-muted">Not shared</p>}
      {data.can_share && data.candidates.length ? (
        <div className="flex gap-2">
          <label htmlFor={`share-${postId}`} className="sr-only">Client guest</label>
          <Select id={`share-${postId}`} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Choose a client guest…</option>
            {data.candidates.map((c) => <option key={c.user_id} value={c.user_id}>{c.name || c.email}</option>)}
          </Select>
          <Button size="sm" icon={<UserPlus aria-hidden className="size-4" />} disabledReason={!pick ? 'Choose a guest.' : null}
            onClick={async () => { setErr(null); try { await api.post(`/api/posts/${postId}/review-shares`, { user_id: pick }); setPick(''); toast.success('Shared'); await refetch(); } catch (e) { setErr(e); } }}>
            Share
          </Button>
        </div>
      ) : null}
      {data.can_share && !data.candidates.length && !data.items.length ? <p className="text-[11px] text-subtle">Invite a client as a guest of this brand to share reviews.</p> : null}
      {err ? <ErrorNotice error={err} /> : null}
    </div>
  );
}
