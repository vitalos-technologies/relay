'use client';
// CSV import: choose file → preview (per-row, per-destination checks) → create drafts. Never schedules.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, Upload } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, Dialog, ErrorNotice } from '@/components/ui';

interface PreviewRow { row: number; title: string | null; text: string; destinations: string[]; ok: boolean; issues: Array<{ message: string }> }
interface Preview { csv_hash: string; rows: PreviewRow[]; valid: number; invalid: number }

export function CsvImportDialog({ brandId }: { brandId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<number | null>(null);

  const reset = () => { setCsv(''); setName(''); setPreview(null); setError(null); setDone(null); };

  const choose = async (f: File | undefined) => {
    if (!f) return;
    reset();
    if (f.size > 512 * 1024) { setError(new Error('File is larger than 512 KB.')); return; }
    const text = await f.text();
    setCsv(text); setName(f.name); setBusy(true);
    try { setPreview(await api.post<Preview>(`/api/brands/${brandId}/imports`, { csv: text })); } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ created: Array<{ post_id: string }> }>(`/api/brands/${brandId}/imports/commit`, { csv, csv_hash: preview.csv_hash }, { idempotent: true });
      setDone(r.created.length);
      router.refresh();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <>
      <Button variant="ghost" onClick={() => { reset(); setOpen(true); }} disabledReason={!brandId ? 'Choose a brand.' : null}>
        <Upload aria-hidden className="size-4" /> Import CSV
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title="Import CSV" size="lg" busy={busy}
        footer={done !== null ? <Button variant="primary" onClick={() => setOpen(false)}>Done</Button> : (
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={commit} loading={busy} disabledReason={!preview ? 'Choose a file.' : preview.valid === 0 ? 'No valid rows.' : null}>
              Create {preview?.valid ?? 0} draft{preview?.valid === 1 ? '' : 's'}
            </Button>
          </>
        )}>
        <div className="flex flex-col gap-4">
          {done !== null ? (
            <p className="flex items-center gap-2 text-sm"><CircleCheck aria-hidden className="size-4 text-success" /> {done} draft{done === 1 ? '' : 's'} created. Nothing was scheduled.</p>
          ) : (
            <>
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg bg-raised px-4 py-3 text-sm focus-within:outline focus-within:outline-2">
                <span className="truncate">{name || 'Choose a .csv file'}</span>
                <span className="text-muted">Columns: text, destinations, title, link, image_asset_id, scheduled_local_time, tags</span>
                <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void choose(e.target.files?.[0])} />
              </label>
              {preview ? (
                <div className="max-h-[50vh] overflow-auto">
                  <table className="w-full text-left text-[13px]">
                    <thead className="sticky top-0 bg-surface text-muted"><tr><th className="py-2 pr-3 font-medium">Row</th><th className="py-2 pr-3 font-medium">Post</th><th className="py-2 font-medium">Check</th></tr></thead>
                    <tbody>
                      {preview.rows.map((r) => (
                        <tr key={r.row} className="align-top">
                          <td className="py-2 pr-3 tabular-nums text-muted">{r.row}</td>
                          <td className="max-w-[320px] py-2 pr-3"><p className="truncate font-medium">{r.title ?? r.text}</p><p className="text-xs text-muted">{r.destinations.join(' · ')}</p></td>
                          <td className="py-2">
                            {r.ok ? <span className="inline-flex items-center gap-1 text-success"><CircleCheck aria-hidden className="size-4" /> Ready</span> : (
                              <ul className="flex flex-col gap-1">{r.issues.map((i, k) => <li key={k} className="flex gap-1 text-danger"><CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /><span>{i.message}</span></li>)}</ul>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          )}
          {error ? <ErrorNotice error={error} /> : null}
        </div>
      </Dialog>
    </>
  );
}
