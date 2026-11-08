'use client';
// Customer satisfaction (stream B): only on channels where an admin turned it on, only in private chats. Asking sends a
// normal message ("How did we do? Reply 1–5"); only an explicit 1–5 answer within 7 days is recorded — silence is never a
// score.
import { useRef, useState } from 'react';
import { Star } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, useToast } from '@/components/ui';
import { newKey } from './labels';

interface State { available: boolean; reason: string | null; request: { id: string; state: 'sending' | 'open' | 'answered' | 'expired' | 'not_sent'; score: number | null; requested_at: string; responded_at: string | null } | null }
const LABEL = { sending: 'Sending…', open: 'Waiting for an answer', answered: 'Answered', expired: 'No answer', not_sent: 'Not sent' } as const;

export function CsatPanel({ conversationId, onChanged }: { conversationId: string; onChanged: () => void }) {
  const toast = useToast();
  const { data, refetch } = useApi<State>(`/api/inbox/conversations/${conversationId}/csat`, { poll: 30_000 });
  const [busy, setBusy] = useState(false);
  const key = useRef<string | null>(null);
  if (!data || (!data.available && !data.request)) return null;
  const r = data.request;
  return (
    <div className="flex flex-col gap-2">
      {r ? (
        <p className="flex flex-wrap items-center gap-2">
          {r.state === 'answered' && r.score ? <Badge tone="success" icon={<Star aria-hidden className="size-3.5" />}>{r.score} / 5</Badge> : <Badge tone={r.state === 'not_sent' ? 'warn' : 'neutral'}>{LABEL[r.state]}</Badge>}
          <span className="text-xs text-muted">asked {new Date(r.requested_at).toLocaleDateString()}</span>
        </p>
      ) : null}
      {data.available ? (
        <div><Button size="sm" variant="secondary" loading={busy} onClick={async () => {
          setBusy(true);
          key.current ??= newKey();
          try { await api.post(`/api/inbox/conversations/${conversationId}/csat`, { idempotency_key: key.current }); key.current = null; toast.success('Rating request sent'); await refetch(); onChanged(); } catch (e) { key.current = null; toast.error(e); } finally { setBusy(false); }
        }}>Ask for a rating</Button></div>
      ) : null}
    </div>
  );
}
