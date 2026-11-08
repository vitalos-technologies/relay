'use client';
// Saved search editor: names + aliases, keywords, exclusions, optional Boolean query (validated live with the same parser
// as the server), languages, sources, kinds. "Test" previews the definition against stored mentions without saving.
// Editing the definition creates a new query version (charts show the version they were computed with).
import { useMemo, useState } from 'react';
import { parseQuery, QueryError, type SavedSearchDto, type SearchRole, type ListeningSourceState } from '@social-lite/core/contracts/v35-listening';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useBrands, useSession } from '@/lib/client/session';
import { Button, Checkbox, Dialog, Field, Input, Segmented, Select, Textarea, useToast } from '@/components/ui';
import { ROLE_LABEL, fmtDay } from './shared';

const LANGS = [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch']] as const;
const list = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

export function SearchForm({ open, onOpenChange, search, defaultBrand, onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; search?: SavedSearchDto | null; defaultBrand?: string; onSaved: (s: SavedSearchDto) => void;
}) {
  const toast = useToast();
  const brands = useBrands();
  const { canOn } = useSession();
  const manageable = brands.filter((b) => canOn(b.id, 'listening.manage'));
  const [brand, setBrand] = useState(search?.brand_id ?? defaultBrand ?? manageable[0]?.id ?? '');
  const [name, setName] = useState(search?.name ?? '');
  const [role, setRole] = useState<SearchRole>(search?.role ?? 'own');
  const [terms, setTerms] = useState((search?.terms ?? []).join(', '));
  const [keywords, setKeywords] = useState((search?.keywords ?? []).join(', '));
  const [exclusions, setExclusions] = useState((search?.exclusions ?? []).join(', '));
  const [boolean, setBoolean] = useState(search?.boolean ?? '');
  const [langs, setLangs] = useState<string[]>(search?.languages ?? []);
  const [sources, setSources] = useState<string[]>(search?.sources ?? []);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ matched: number; scanned: number; sample: Array<{ id: string; text: string; occurred_at: string }>; dataset: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const srcs = useApi<{ items: ListeningSourceState[] }>(open ? `/api/listening/sources${brand ? `?brand_id=${brand}` : ''}` : null);

  const queryError = useMemo(() => {
    if (!boolean.trim()) return null;
    try { parseQuery(boolean.trim(), { allowOnlyNegative: list(terms).length + list(keywords).length > 0 }); return null; } catch (e) { return e instanceof QueryError ? `${e.message} (at character ${e.position + 1})` : 'Invalid query'; }
  }, [boolean, terms, keywords]);
  const def = { terms: list(terms), keywords: list(keywords), exclusions: list(exclusions), boolean: boolean.trim() || null, languages: langs, sources, kinds: [] as string[] };
  const empty = !def.terms.length && !def.keywords.length && !def.boolean;

  const test = async () => {
    setBusy(true); setFieldErrors({});
    try { setPreview(await api.post('/api/listening/searches/preview', { brand_id: brand, ...def })); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setFieldErrors({});
    try {
      const s = search
        ? await api.patch<SavedSearchDto>(`/api/listening/searches/${search.id}`, { name: name.trim(), role, ...def, kinds: undefined, expected_version: search.version })
        : await api.post<SavedSearchDto>('/api/listening/searches', { brand_id: brand, name: name.trim(), role, ...def });
      toast.success(search ? (s.version !== search.version ? `Saved as version ${s.version}` : 'Saved') : 'Search created');
      onSaved(s);
      onOpenChange(false);
    } catch (e) {
      setFieldErrors(((e as { fieldErrors?: Record<string, string> }).fieldErrors) ?? {});
      toast.error(e);
    } finally { setBusy(false); }
  };

  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" busy={busy} title={search ? `Edit “${search.name}”` : 'New saved search'}
      footer={<>
        <Button variant="ghost" onClick={test} disabled={busy || empty || !!queryError || !brand}>Test</Button>
        <Button variant="primary" onClick={save} disabled={busy || empty || !!queryError || !name.trim() || !brand}>{search ? 'Save' : 'Create'}</Button>
      </>}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={fieldErrors.name}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Vitalos" /></Field>
          {!search ? (
            <Field label="Brand"><Select value={brand} onChange={(e) => { setBrand(e.target.value); setPreview(null); }}>{manageable.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium">Type</span>
          <Segmented label="Type" value={role} onChange={setRole} options={(['own', 'competitor', 'topic'] as const).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
        </div>
        <Field label="Names and aliases" hint="Comma-separated. Any match counts." error={fieldErrors.terms}><Textarea rows={2} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Vitalos, Vitalos Café, #vitalos" /></Field>
        <Field label="Keywords" optional hint="Also match any of these." error={fieldErrors.keywords}><Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="flat white, oat latte" /></Field>
        <Field label="Exclude" optional hint="Any of these removes the item." error={fieldErrors.exclusions}><Input value={exclusions} onChange={(e) => setExclusions(e.target.value)} placeholder="job, hiring" /></Field>
        <Field label="Advanced query" optional error={queryError ?? fieldErrors.boolean}
          info={<>Must also match. AND, OR, NOT (upper case), &ldquo;exact phrase&rdquo; in double quotes, (brackets), prefix*, #tag, @handle. Example: <code>(latte OR mocha) NOT decaf</code></>}>
          <Input value={boolean} onChange={(e) => setBoolean(e.target.value)} placeholder='"flat white" OR latte*' spellCheck={false} />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[13px] font-medium">Languages <span className="font-normal text-subtle">· none = any</span></legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">{LANGS.map(([c, l]) => <Checkbox key={c} label={l} checked={langs.includes(c)} onChange={() => toggle(langs, c, setLangs)} />)}</div>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[13px] font-medium">Sources <span className="font-normal text-subtle">· none = all monitored</span></legend>
          <div className="flex flex-col gap-2">
            {(srcs.data?.items ?? []).filter((s) => s.layer === 'connected' && (s.channels.length || sources.includes(s.key))).map((s) => (
              <Checkbox key={s.key} label={s.label} description={`${s.channels.length} channel${s.channels.length === 1 ? '' : 's'}`} checked={sources.includes(s.key)} onChange={() => toggle(sources, s.key, setSources)} />
            ))}
            {srcs.data && !srcs.data.items.some((s) => s.layer === 'connected' && s.channels.length) ? <p className="text-xs text-muted">No monitored channel for this brand yet.</p> : null}
          </div>
        </fieldset>
        {preview ? (
          <div role="status" className="rounded-lg border border-border bg-sunken p-3 text-[13px]">
            <p className="font-medium">{preview.matched} of {preview.scanned} stored mentions match <span className="font-normal text-muted">(last 30 days{preview.dataset === 'simulated' ? ', simulated' : ''})</span></p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {preview.sample.map((s) => <li key={s.id} className="line-clamp-2 text-muted"><span className="text-subtle">{fmtDay(s.occurred_at)} · </span>{s.text}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
