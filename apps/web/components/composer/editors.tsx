'use client';
import { useState } from 'react';
import { ImagePlus, Plus, Trash2, X } from 'lucide-react';
import { PROVIDER_LABEL, type DraftContent, type UrlButton, type VariantDraft } from '@social-lite/core';
import { UNIT_LABEL, constraintsOf, type LocalCheck } from '@/lib/client/variants';
import { connectionFix, isDispatchable } from '@/lib/client/connection-fix';
import type { Asset, Brand, Connection } from '@/lib/client/types';
import {
  Banner, Button, Checkbox, cn, ConnectionStatusBadge, Field, IconButton, InfoTip, Input, PlatformIcon, RadioGroup, Segmented,
  SimulatedBadge, Textarea,
} from '@/components/ui';
import { MediaPicker } from './media-picker';

// ------------------------------------------------------------------ counter
export function Counter({ check, id }: { check: LocalCheck | undefined; id?: string }) {
  if (!check || !check.hasConstraints || check.measured === null || check.limit === null) return null;
  const over = check.measured > check.limit;
  const near = !over && check.measured > check.limit * 0.9;
  return (
    <span id={id} className={cn('text-xs tabular', over ? 'font-medium text-danger' : near ? 'text-warn' : 'text-muted')}>
      {check.measured.toLocaleString('en-GB')} / {check.limit.toLocaleString('en-GB')}
      <span className="sr-only"> {check.unit ? UNIT_LABEL[check.unit] : ''}{over ? `, ${check.measured - check.limit} over the limit` : ''}</span>
    </span>
  );
}

// ------------------------------------------------------------------ media strip
export function MediaStrip({
  ids, assets, onRemove, onAdd, disabled, label,
}: { ids: string[]; assets: Map<string, Asset>; onRemove: (id: string) => void; onAdd: () => void; disabled?: boolean; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {ids.map((id) => {
        const a = assets.get(id);
        const state = !a ? 'Missing' : a.status === 'ready' ? null : a.status === 'rejected' ? 'Rejected' : 'Processing';
        return (
          <div key={id} className="relative size-20 overflow-hidden rounded-lg border border-border bg-sunken">
            {a?.thumb_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={a.thumb_url} alt={a.alt_text || a.original_filename} className="size-full object-cover" />
            ) : <span className="flex size-full items-center justify-center p-1 text-center text-[10px] text-muted">{a?.original_filename ?? 'Unavailable'}</span>}
            {state ? <span className="absolute inset-x-0 bottom-0 bg-[var(--overlay)] px-1 py-0.5 text-center text-[10px] font-medium text-white">{state}</span> : null}
            {!disabled ? (
              <button
                type="button"
                onClick={() => onRemove(id)}
                aria-label={`Remove ${a?.original_filename ?? 'image'}`}
                className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-[var(--overlay)] text-white hover:bg-black"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            ) : null}
          </div>
        );
      })}
      {!disabled ? (
        <button type="button" onClick={onAdd} className="flex size-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong text-xs text-muted hover:border-[var(--focus)] hover:text-fg">
          <ImagePlus aria-hidden className="size-5" />
          Add
        </button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ base editor
export function BaseEditor({
  draft, onChange, readOnly, brand, assets, onAssetsSeen, maxImages, canUpload, checksFor,
}: {
  draft: DraftContent; onChange: (d: DraftContent) => void; readOnly: boolean; brand: Brand; assets: Map<string, Asset>;
  onAssetsSeen: (a: Asset[]) => void; maxImages: number; canUpload: boolean; checksFor: Array<{ check: LocalCheck; connection: Connection }>;
}) {
  const [picker, setPicker] = useState(false);
  const prohibited = (brand.voice?.prohibited ?? []).filter((t) => t && draft.baseText.toLowerCase().includes(t.toLowerCase()));
  const linkInvalid = !!draft.baseLink && !/^https:\/\/\S+$/i.test(draft.baseLink);
  const voice = brand.voice ?? {};
  const append = (s: string) => onChange({ ...draft, baseText: draft.baseText.trimEnd() ? `${draft.baseText.trimEnd()}\n\n${s}` : s });

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Text"
        info="Shared by every destination set to “Inherited”. Each network counts length its own way."
      >
        <Textarea
          value={draft.baseText}
          onChange={(e) => onChange({ ...draft, baseText: e.target.value })}
          readOnly={readOnly}
          rows={8}
          className="min-h-48 text-[14px]"
          placeholder="Write your post…"
        />
      </Field>
      {checksFor.length ? (
        <ul className="-mt-3 flex flex-wrap gap-x-4 gap-y-1" aria-label="Length per destination">
          {checksFor.filter((c) => c.check.hasConstraints).map(({ check, connection }) => (
            <li key={connection.id} className="flex items-center gap-1.5 text-xs text-muted">
              <PlatformIcon provider={connection.provider} size="xs" decorative />
              <span className="sr-only">{PROVIDER_LABEL[connection.provider]} {connection.display_name}:</span>
              <Counter check={check} />
            </li>
          ))}
        </ul>
      ) : null}
      {!readOnly && (voice.default_cta || voice.hashtags?.length || voice.footer) ? (
        <div className="-mt-2 flex flex-wrap items-center gap-2">
          {voice.default_cta ? <Button size="sm" variant="quiet" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => append(voice.default_cta!)}>CTA<span className="sr-only"> (brand call to action)</span></Button> : null}
          {voice.hashtags?.length ? <Button size="sm" variant="quiet" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => append(voice.hashtags!.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' '))}>Hashtags</Button> : null}
          {voice.footer ? <Button size="sm" variant="quiet" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => append(voice.footer!)}>Footer</Button> : null}
        </div>
      ) : null}
      {prohibited.length ? (
        <Banner tone="warn" title={`Avoided terms: ${prohibited.join(', ')}`} />
      ) : null}
      <Field label="Link" optional info="Appended to the text where a network has no link field." error={linkInvalid ? 'Use a full https:// link.' : null}>
        <Input type="url" inputMode="url" value={draft.baseLink ?? ''} readOnly={readOnly} onChange={(e) => onChange({ ...draft, baseLink: e.target.value || null })} placeholder="https://" />
      </Field>
      <div>
        <p className="mb-2 text-[13px] font-medium">Media</p>
        <MediaStrip
          label="Base media"
          ids={draft.baseAssetIds}
          assets={assets}
          disabled={readOnly}
          onAdd={() => setPicker(true)}
          onRemove={(id) => onChange({ ...draft, baseAssetIds: draft.baseAssetIds.filter((x) => x !== id) })}
        />
      </div>
      <MediaPicker
        open={picker}
        onOpenChange={setPicker}
        brandId={brand.id}
        selected={draft.baseAssetIds}
        max={maxImages}
        canUpload={canUpload}
        onAssetsSeen={onAssetsSeen}
        onConfirm={(ids) => onChange({ ...draft, baseAssetIds: ids })}
      />
    </div>
  );
}

// ------------------------------------------------------------------ variant editor
type LinkMode = 'inherit' | 'custom' | 'none';

export function VariantEditor({
  draft, variant, connection, onChange, readOnly, brandId, assets, onAssetsSeen, check, canUpload,
}: {
  draft: DraftContent; variant: VariantDraft; connection: Connection; onChange: (v: VariantDraft) => void; readOnly: boolean;
  brandId: string; assets: Map<string, Asset>; onAssetsSeen: (a: Asset[]) => void; check: LocalCheck | undefined; canUpload: boolean;
}) {
  const [picker, setPicker] = useState(false);
  const k = constraintsOf(connection);
  const linkMode: LinkMode = variant.link === undefined ? 'inherit' : variant.link === null ? 'none' : 'custom';
  const supportsButtons = k ? k.supportsButtons : connection.provider === 'telegram';
  const maxButtons = k?.maxButtons ?? 8;
  const buttons = variant.buttons ?? [];
  const setButtons = (b: UrlButton[]) => onChange({ ...variant, buttons: b });
  const counterId = `ctr-${connection.id}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <PlatformIcon provider={connection.provider} size="md" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm font-medium">{connection.display_name} {connection.is_mock ? <SimulatedBadge /> : null}</p>
          <p className="truncate text-xs text-muted">{PROVIDER_LABEL[connection.provider]}{connection.username ? ` · @${connection.username.replace(/^@/, '')}` : ''}</p>
        </div>
        <ConnectionStatusBadge status={connection.status} label={connection.status_label} size="sm" />
      </div>
      {!isDispatchable(connection) ? <Banner tone="warn" title="Can’t publish">{connectionFix(connection) ?? connection.health?.message}</Banner> : null}
      {!k ? <p className="flex items-center gap-1 text-xs text-muted">Limits unknown<InfoTip label="About limits">Run Check on Accounts to load limits. The server still validates.</InfoTip></p> : null}

      <section aria-labelledby={`txt-${connection.id}`} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id={`txt-${connection.id}`} className="text-[13px] font-medium">Text</h3>
          <Segmented
            label={`Text source for ${connection.display_name}`}
            size="sm"
            value={variant.inheritText ? 'inherit' : 'custom'}
            onChange={(v) => {
              if (readOnly) return;
              if (v === 'inherit') onChange({ ...variant, inheritText: true });
              else onChange({ ...variant, inheritText: false, text: variant.text ?? draft.baseText });
            }}
            options={[{ value: 'inherit', label: 'Inherited', disabled: readOnly }, { value: 'custom', label: 'Custom', disabled: readOnly }]}
          />
        </div>
        {variant.inheritText ? (
          <div className="rounded-lg bg-sunken px-4 py-3">
            <p className="whitespace-pre-wrap break-words text-[13px] text-muted">{draft.baseText || 'Empty'}</p>
          </div>
        ) : (
          <Field label={`Custom text for ${connection.display_name}`} labelHidden>
            <Textarea
              value={variant.text ?? ''}
              readOnly={readOnly}
              onChange={(e) => onChange({ ...variant, text: e.target.value })}
              rows={6}
              className="min-h-36"
              aria-describedby={counterId}
            />
          </Field>
        )}
        <div className="flex justify-end"><Counter check={check} id={counterId} /></div>
      </section>

      <section aria-labelledby={`lnk-${connection.id}`} className="flex flex-col gap-3">
        <h3 id={`lnk-${connection.id}`} className="text-[13px] font-medium">Link</h3>
        <RadioGroup<LinkMode>
          name={`link-${connection.id}`}
          legend="Link for this destination"
          legendHidden
          value={linkMode}
          onChange={(m) => {
            if (readOnly) return;
            if (m === 'inherit') { const { link: _l, ...rest } = variant; onChange(rest as VariantDraft); }
            else if (m === 'none') onChange({ ...variant, link: null });
            else onChange({ ...variant, link: variant.link ?? draft.baseLink ?? '' });
          }}
          options={[
            { value: 'inherit', label: 'Inherited', description: draft.baseLink || 'None', disabled: readOnly },
            { value: 'custom', label: 'Custom', disabled: readOnly },
            { value: 'none', label: 'No link', disabled: readOnly },
          ]}
        />
        {linkMode === 'custom' ? (
          <Field label="Link URL" labelHidden error={variant.link && !/^https:\/\/\S+$/i.test(variant.link) ? 'Use a full https:// link.' : null}>
            <Input type="url" inputMode="url" value={variant.link ?? ''} readOnly={readOnly} onChange={(e) => onChange({ ...variant, link: e.target.value })} placeholder="https://" />
          </Field>
        ) : null}
        {k && !k.supportsLink ? <p className="text-xs text-warn">Links aren’t clickable on {PROVIDER_LABEL[connection.provider]}.</p> : null}
      </section>

      <section aria-labelledby={`med-${connection.id}`} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id={`med-${connection.id}`} className="text-[13px] font-medium">Media</h3>
          <Segmented
            label={`Media source for ${connection.display_name}`}
            size="sm"
            value={variant.inheritMedia ? 'inherit' : 'custom'}
            onChange={(v) => {
              if (readOnly) return;
              if (v === 'inherit') onChange({ ...variant, inheritMedia: true });
              else onChange({ ...variant, inheritMedia: false, assetIds: variant.assetIds ?? draft.baseAssetIds });
            }}
            options={[{ value: 'inherit', label: 'Inherited', disabled: readOnly }, { value: 'custom', label: 'Custom', disabled: readOnly }]}
          />
        </div>
        <MediaStrip
          label={`Media for ${connection.display_name}`}
          ids={variant.inheritMedia ? draft.baseAssetIds : variant.assetIds ?? []}
          assets={assets}
          disabled={readOnly || variant.inheritMedia}
          onAdd={() => setPicker(true)}
          onRemove={(id) => onChange({ ...variant, assetIds: (variant.assetIds ?? []).filter((x) => x !== id) })}
        />
        {k?.requiresMedia ? <p className="text-xs text-muted">Image required</p> : null}
        <MediaPicker
          open={picker}
          onOpenChange={setPicker}
          brandId={brandId}
          selected={variant.assetIds ?? []}
          max={Math.max(1, k?.maxImages ?? 1)}
          canUpload={canUpload}
          onAssetsSeen={onAssetsSeen}
          onConfirm={(ids) => onChange({ ...variant, inheritMedia: false, assetIds: ids })}
        />
      </section>

      {supportsButtons ? (
        <section aria-labelledby={`btn-${connection.id}`} className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h3 id={`btn-${connection.id}`} className="text-[13px] font-medium">URL buttons <span className="font-normal text-muted">({buttons.length}/{maxButtons})</span></h3>
            {!readOnly ? (
              <Button size="sm" variant="ghost" icon={<Plus aria-hidden className="size-4" />} onClick={() => setButtons([...buttons, { text: '', url: '' }])} disabled={buttons.length >= maxButtons}>
                Add<span className="sr-only"> button</span>
              </Button>
            ) : null}
          </div>
          {buttons.length === 0 ? null : (
            <ul className="flex flex-col gap-3">
              {buttons.map((b, i) => (
                <li key={i} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
                  <Field label={`Button ${i + 1} label`} error={!b.text.trim() && b.url ? 'Add a label.' : null}>
                    <Input value={b.text} readOnly={readOnly} maxLength={64} onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                  </Field>
                  <Field label={`Button ${i + 1} URL`} className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto" error={b.url && !/^https:\/\/\S+$/i.test(b.url) ? 'Use a full https:// link.' : null}>
                    <Input type="url" inputMode="url" value={b.url} readOnly={readOnly} onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} placeholder="https://" />
                  </Field>
                  {!readOnly ? (
                    <div className="col-start-2 row-start-1 flex items-end sm:col-start-auto sm:row-start-auto">
                      <IconButton label={`Remove button ${i + 1}`} icon={<Trash2 aria-hidden className="size-4" />} onClick={() => setButtons(buttons.filter((_, j) => j !== i))} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ destination picker
export function DestinationPicker({
  connections, selected, onToggle, readOnly,
}: { connections: Connection[]; selected: string[]; onToggle: (c: Connection, on: boolean) => void; readOnly: boolean }) {
  const live = connections.filter((c) => c.status !== 'disconnected' || selected.includes(c.id));
  if (!live.length) return null;
  return (
    <ul className="flex flex-col">
      {live.map((c) => {
        const on = selected.includes(c.id);
        // Paused destinations can still be scheduled (they send once resumed); others must be fixed first.
        const ok = isDispatchable(c) || c.status === 'paused' || (c.paused && (c.status === 'ready' || c.status === 'expiring'));
        const reason = isDispatchable(c) ? null : connectionFix(c) ?? c.health?.message ?? c.status_label;
        return (
          <li key={c.id} className={cn('rounded-lg px-2 py-2 transition-colors', on ? 'bg-raised/60' : '')}>
            <div className="flex items-center gap-3">
              <Checkbox
                className="min-w-0 flex-1 [&_label]:block [&_label]:truncate"
                checked={on}
                disabled={readOnly || (!ok && !on)}
                onChange={(e) => onToggle(c, e.target.checked)}
                label={<span className="flex min-w-0 items-center gap-2"><PlatformIcon provider={c.provider} size="xs" decorative /><span className="truncate font-medium">{c.display_name}</span><span className="sr-only"> ({PROVIDER_LABEL[c.provider]})</span></span>}
              />
              {c.status !== 'ready' ? <ConnectionStatusBadge status={c.status} label={c.status_label} size="sm" /> : null}
              {c.is_mock ? <SimulatedBadge className="shrink-0" /> : null}
            </div>
            {reason ? <p className="mt-1 truncate pl-8 text-xs text-muted" title={reason}>{ok ? '' : on ? 'Can’t publish: ' : 'Unavailable: '}{reason}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
