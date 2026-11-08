'use client';
import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { allTimeZones } from '@/lib/client/format';
import { Button, Card, CardHeader, ErrorNotice, Field, InfoTip, Input, Select, Skeleton, Switch, useToast } from '@/components/ui';

interface Prefs {
  events: Array<{ event_type: string; in_app: boolean; email: boolean; digest: boolean }>;
  timezone: string; quiet_start: number | null; quiet_end: number | null; digest_hour: number;
}

const LABEL: Record<string, string> = {
  mention: 'Mentions', comment: 'Replies and client comments', review_requested: 'Review requests', review_decided: 'Review decisions',
  assignment: 'Tasks and assignments', reminder: 'Deadline reminders', publishing_problem: 'Publishing problems', account_health: 'Account health', budget: 'Budgets', support: 'Relay support replies',
};
const toHm = (m: number | null) => (m === null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const fromHm = (v: string) => { const [h, m] = v.split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : null; };

/** Per-event channels, quiet hours and daily digest. Security alerts always arrive immediately. */
export function NotificationPrefs() {
  const toast = useToast();
  const { data, error, loading, setData } = useApi<Prefs>('/api/notification-preferences');
  const [f, setF] = useState<Prefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (data) setF(structuredClone(data)); }, [data]);
  if (error && !data) return <ErrorNotice error={error} />;
  if (loading || !f) return <Skeleton className="h-72 w-full rounded-xl" />;
  const quietOn = f.quiet_start !== null;
  const setEvent = (t: string, patch: Partial<Prefs['events'][number]>) =>
    setF({ ...f, events: f.events.map((e) => (e.event_type === t ? { ...e, ...patch, ...(patch.email ? { digest: false } : patch.digest ? { email: false } : {}) } : e)) });
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.put<Prefs>('/api/notification-preferences', { events: f.events, timezone: f.timezone, quiet_start: f.quiet_start, quiet_end: f.quiet_end, digest_hour: f.digest_hour });
      setData(r); toast.success('Notifications saved');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><BellRing aria-hidden className="size-4" /> Notifications</span>} />
      <div className="p-4">
        <table className="w-full text-[13px]">
          <caption className="sr-only">Channels per notification type</caption>
          <thead><tr className="text-left text-xs text-muted"><th className="pb-2 font-normal">Type</th><th className="pb-2 text-center font-normal">In app</th><th className="pb-2 text-center font-normal">Email</th><th className="pb-2 text-center font-normal">Digest</th></tr></thead>
          <tbody>
            {f.events.map((e) => (
              <tr key={e.event_type} className="border-t border-border">
                <th scope="row" className="py-2 text-left font-normal">{LABEL[e.event_type] ?? e.event_type}</th>
                {(['in_app', 'email', 'digest'] as const).map((k) => (
                  <td key={k} className="py-2 text-center">
                    <input type="checkbox" className="size-[18px] cursor-pointer accent-[var(--text)]" aria-label={`${LABEL[e.event_type]}: ${k.replace('_', '-')}`}
                      checked={e[k]} onChange={(ev) => setEvent(e.event_type, { [k]: ev.target.checked })} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Switch className="sm:col-span-2" checked={quietOn} onCheckedChange={(v) => setF({ ...f, quiet_start: v ? 22 * 60 : null, quiet_end: v ? 7 * 60 : null })}
            label="Quiet hours" description="Emails wait until morning. Security alerts still arrive." />
          {quietOn ? (
            <>
              <Field label="From"><Input type="time" value={toHm(f.quiet_start)} onChange={(e) => setF({ ...f, quiet_start: fromHm(e.target.value) })} /></Field>
              <Field label="Until"><Input type="time" value={toHm(f.quiet_end)} onChange={(e) => setF({ ...f, quiet_end: fromHm(e.target.value) })} /></Field>
            </>
          ) : null}
          <Field label={<span className="inline-flex items-center">Digest at<InfoTip label="About the digest">One email a day with titles only.</InfoTip></span>}>
            <Select value={String(f.digest_hour)} onChange={(e) => setF({ ...f, digest_hour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </Select>
          </Field>
          <Field label="Time zone">
            <Select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
              {allTimeZones().map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </Select>
          </Field>
        </div>
        {err ? <ErrorNotice error={err} className="mt-4" /> : null}
        <Button variant="primary" className="mt-4" onClick={save} loading={busy} disabledReason={JSON.stringify(f) === JSON.stringify(data) ? 'No changes.' : null}>Save</Button>
      </div>
    </Card>
  );
}
