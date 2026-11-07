'use client';
// Settings → Brand: duplicate/collision warning window and client handover export (stream D).
import { useEffect, useState } from 'react';
import { Copy, PackageOpen } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Button, Card, CardHeader, ErrorNotice, Field, InfoTip, Input, Segmented, useToast } from '@/components/ui';
import { postDownload } from './download';

interface WindowView { brand_id: string; duplicate_window_hours: number; can_edit: boolean }

export function BrandProductSettings({ brandId }: { brandId: string }) {
  return (
    <>
      <DuplicateWindow brandId={brandId} />
      <HandoverExport brandId={brandId} />
    </>
  );
}

function DuplicateWindow({ brandId }: { brandId: string }) {
  const toast = useToast();
  const { data, setData, error } = useApi<WindowView>(`/api/brands/${brandId}/duplicate-window`);
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (data) setV(String(data.duplicate_window_hours)); }, [data]);
  if (error || !data) return null;
  const n = Number(v);
  const bad = !Number.isInteger(n) || n < 0 || n > 720;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      setData(await api.patch<WindowView>(`/api/brands/${brandId}/duplicate-window`, { duplicate_window_hours: n }));
      toast.success('Duplicate check saved');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-1.5"><Copy aria-hidden className="size-4" />Duplicate check <InfoTip>Warns before scheduling similar text or the same media to the same destination within this many hours. A warning only — it never blocks without your confirmation. 0 = off.</InfoTip></span>} />
      <div className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Window (hours)" error={bad ? '0–720' : null}>
          <Input type="number" inputMode="numeric" min={0} max={720} value={v} disabled={!data.can_edit} onChange={(e) => setV(e.target.value)} className="max-w-[140px] tabular" />
        </Field>
        {data.can_edit ? <Button variant="secondary" onClick={save} loading={busy} disabled={n === data.duplicate_window_hours} disabledReason={bad ? '0–720 hours.' : null}>Save</Button> : null}
        {err ? <ErrorNotice error={err} className="w-full" /> : null}
      </div>
    </Card>
  );
}

function HandoverExport({ brandId }: { brandId: string }) {
  const { session } = useSession();
  const toast = useToast();
  const [format, setFormat] = useState<'zip' | 'json'>('zip');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await postDownload(`/api/brands/${brandId}/handover-export`, { format }, session.csrf_token);
      toast.success('Handover export downloaded', `${r.filename} · links valid 15 min`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-1.5"><PackageOpen aria-hidden className="size-4" />Client handover <InfoTip>This brand’s posts, every revision, delivery history and media list with download links valid for 15 minutes. Needs export permission on this brand. Audited; 3 per hour.</InfoTip></span>} />
      <div className="flex flex-wrap items-center gap-3 p-4">
        <Segmented label="Format" size="sm" value={format} onChange={setFormat} options={[{ value: 'zip', label: 'ZIP' }, { value: 'json', label: 'JSON' }]} />
        <Button variant="secondary" onClick={run} loading={busy}>Export</Button>
        {err ? <ErrorNotice error={err} className="w-full" /> : null}
      </div>
    </Card>
  );
}
