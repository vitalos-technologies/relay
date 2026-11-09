'use client';
// Provider-specific fields the composer must collect (capabilities.requiredOptions → variant.options.<provider>.<key>).
// Values are only ever chosen by the user (no defaults for TikTok privacy / YouTube privacy / made-for-kids); the server
// re-validates every one (ValidationIssue field 'options').
import type { ReactNode } from 'react';
import { PROVIDER_LABEL, type ChannelCapabilities, type VariantDraft } from '@social-lite/core';
import type { Connection } from '@/lib/client/types';
import { useApi } from '@/lib/client/use-api';
import { Banner, Checkbox, Field, Input, RadioGroup, Select, Switch, cn } from '@/components/ui';

type Opts = Record<string, unknown>;

const TIKTOK_PRIVACY: Array<{ value: string; label: string }> = [
  { value: 'PUBLIC_TO_EVERYONE', label: 'Everyone' },
  { value: 'MUTUAL_FOLLOW_FRIENDS', label: 'Friends' },
  { value: 'FOLLOWER_OF_CREATOR', label: 'Followers' },
  { value: 'SELF_ONLY', label: 'Only me' },
];

// Used only until the connection's capabilities are loaded (Check on Connections); the server always validates.
const REQUIRED_FALLBACK: Record<string, string[]> = {
  youtube: ['youtube.title', 'youtube.privacyStatus', 'youtube.madeForKids'],
  tiktok: ['tiktok.privacyLevel', 'tiktok.consent'],
};

export function hasProviderOptions(c: Connection): boolean {
  return ['tiktok', 'youtube', 'pinterest', 'linkedin', 'bluesky'].includes(c.provider);
}

/** GET /api/connections/:id/tiktok-creator-info (live creator_info). */
interface TikTokCreatorInfo {
  privacy_level_options: string[];
  interactions: { comment_disabled: boolean; duet_disabled: boolean; stitch_disabled: boolean };
  creator: { nickname: string | null; username: string | null };
}

export function ProviderOptions({
  connection, variant, onChange, readOnly, issues, photoOnly = false,
}: {
  connection: Connection; variant: VariantDraft; onChange: (v: VariantDraft) => void; readOnly: boolean; issues: string[];
  /** Every attached item is an image (TikTok photo post: only Comment applies). */
  photoOnly?: boolean;
}) {
  const caps = connection.capabilities as Partial<ChannelCapabilities>;
  const required = new Set(caps.requiredOptions ?? REQUIRED_FALLBACK[connection.provider] ?? []);
  const p = connection.provider;
  const all = (variant.options ?? {}) as Record<string, unknown>;
  const o = ((all[p] ?? {}) as Opts);
  const set = (patch: Opts) => {
    if (readOnly) return;
    const next = { ...o, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
    onChange({ ...variant, options: { ...all, [p]: next } });
  };
  const req = (k: string) => required.has(`${p}.${k}`);
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  const bool = (k: string) => o[k] === true;

  // TikTok Direct Post: the creator's current settings (TikTok requires creator_info when rendering the post page).
  const direct = p === 'tiktok' && (caps.publishMode ?? 'direct') === 'direct';
  const creator = useApi<TikTokCreatorInfo>(direct ? `/api/connections/${connection.id}/tiktok-creator-info` : null);

  let body: ReactNode = null;
  if (p === 'tiktok') {
    const mode = caps.publishMode;
    const ci = creator.data;
    const privacy = ci && ci.privacy_level_options.length ? TIKTOK_PRIVACY.filter((x) => ci.privacy_level_options.includes(x.value)) : TIKTOK_PRIVACY;
    const chosen = str('privacyLevel');
    const stale = !!chosen && !privacy.some((x) => x.value === chosen);
    const locked = { comment: !!ci?.interactions.comment_disabled, duet: !!ci?.interactions.duet_disabled, stitch: !!ci?.interactions.stitch_disabled };
    const offInTikTok = 'Turned off in the creator’s TikTok settings';
    // TikTok guidelines: every interaction starts off and is only on when the user turns it on (unset = off, which is what is sent).
    const interaction = (key: 'allowComment' | 'allowDuet' | 'allowStitch', label: string, isLocked: boolean) => (
      <Switch checked={!isLocked && bool(key)} onCheckedChange={(v) => set({ [key]: v })} disabled={readOnly || isLocked} label={label} description={isLocked ? offInTikTok : undefined} />
    );
    body = (
      <>
        {mode === 'draft_handoff' ? <Banner tone="info" title="Sent to the creator’s TikTok inbox to finish in the app" /> : null}
        {mode === 'manual' ? <Banner tone="info" title="Manual handoff: download and post in TikTok" /> : null}
        {direct && creator.error ? <Banner tone="warn" title="Couldn’t load the creator’s TikTok settings">Relay checks them again before posting.</Banner> : null}
        <Field label="Who can view" optional={!req('privacyLevel')}>
          <Select value={chosen} onChange={(e) => set({ privacyLevel: e.target.value || undefined })} disabled={readOnly}>
            <option value="">Choose…</option>
            {privacy.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            {stale ? <option value={chosen}>{TIKTOK_PRIVACY.find((x) => x.value === chosen)?.label ?? chosen} (not available)</option> : null}
          </Select>
        </Field>
        <div className={cn('grid grid-cols-1 gap-3', !photoOnly && 'sm:grid-cols-3')} role="group" aria-label="Interactions">
          {interaction('allowComment', 'Allow comments', locked.comment)}
          {photoOnly ? null : interaction('allowDuet', 'Allow Duet', locked.duet)}
          {photoOnly ? null : interaction('allowStitch', 'Allow Stitch', locked.stitch)}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Switch checked={bool('brandOrganic')} onCheckedChange={(v) => set({ brandOrganic: v })} disabled={readOnly} label="Your brand" description="Labelled “Promotional content”" />
          <Switch checked={bool('brandContent')} onCheckedChange={(v) => set({ brandContent: v })} disabled={readOnly} label="Branded content" description="Labelled “Paid partnership”" />
          <Switch checked={bool('isAigc')} onCheckedChange={(v) => set({ isAigc: v })} disabled={readOnly} label="AI-generated" />
        </div>
        <Field label="Photo title" optional hint="Photo posts only, up to 90 characters.">
          <Input value={str('title')} maxLength={90} readOnly={readOnly} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Checkbox
          checked={bool('consent')}
          disabled={readOnly}
          onChange={(e) => set({ consent: e.target.checked })}
          label={<>I agree to TikTok’s Music Usage Confirmation{bool('brandContent') ? ' and Branded Content Policy' : ''}{req('consent') ? <span className="text-danger"> *</span> : null}</>}
        />
      </>
    );
  } else if (p === 'youtube') {
    const native = !!caps.nativeScheduling;
    body = (
      <>
        <Field label="Title" optional={!req('title')} hint={`${[...str('title')].length}/100`}>
          <Input value={str('title')} maxLength={100} readOnly={readOnly} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <RadioGroup<string>
            name={`yt-privacy-${connection.id}`}
            legend={<>Privacy{req('privacyStatus') ? <span className="text-danger"> *</span> : null}</>}
            value={str('privacyStatus')}
            onChange={(v) => set({ privacyStatus: v })}
            options={['public', 'unlisted', 'private'].map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1), disabled: readOnly }))}
          />
          <RadioGroup<string>
            name={`yt-kids-${connection.id}`}
            legend={<>Made for kids{req('madeForKids') ? <span className="text-danger"> *</span> : null}</>}
            value={o.madeForKids === true ? 'yes' : o.madeForKids === false ? 'no' : ''}
            onChange={(v) => set({ madeForKids: v === 'yes' })}
            options={[{ value: 'yes', label: 'Yes', disabled: readOnly }, { value: 'no', label: 'No', disabled: readOnly }]}
          />
        </div>
        <Field label="Tags" optional hint="Comma-separated">
          <Input
            value={Array.isArray(o.tags) ? (o.tags as string[]).join(', ') : ''}
            readOnly={readOnly}
            onChange={(e) => set({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
          />
        </Field>
        {native ? (
          <RadioGroup<string>
            name={`yt-owner-${connection.id}`}
            legend="Release"
            value={str('schedulingOwner') || 'app'}
            onChange={(v) => set({ schedulingOwner: v === 'app' ? undefined : v })}
            options={[
              { value: 'app', label: 'Relay uploads at the scheduled time', disabled: readOnly },
              { value: 'provider', label: 'Let YouTube release it', description: 'Uploaded early as private; YouTube publishes at the scheduled time.', disabled: readOnly },
            ]}
          />
        ) : null}
        <Switch checked={bool('containsSyntheticMedia')} onCheckedChange={(v) => set({ containsSyntheticMedia: v })} disabled={readOnly} label="Altered or synthetic content" />
      </>
    );
  } else if (p === 'pinterest') {
    body = (
      <>
        <p className="text-[13px]"><span className="text-muted">Board</span> <span className="font-medium">{connection.display_name}</span></p>
        <Field label="Pin title" optional hint="Up to 100 characters.">
          <Input value={str('title')} maxLength={100} readOnly={readOnly} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="Alt text" optional hint="Up to 500 characters. Empty: the image’s library alt text.">
          <Input value={str('altText')} maxLength={500} readOnly={readOnly} onChange={(e) => set({ altText: e.target.value })} />
        </Field>
      </>
    );
  } else if (p === 'linkedin') {
    const org = /organi[sz]ation/i.test(caps.eligibility?.message ?? '');
    body = (
      <>
        <p className="text-[13px]"><span className="text-muted">Posting as</span> <span className="font-medium">{connection.display_name}</span> <span className="text-muted">· {org ? 'Organisation' : 'Member'}</span></p>
        {!org ? (
          <Field label="Visibility">
            <Select value={str('visibility') || 'PUBLIC'} onChange={(e) => set({ visibility: e.target.value === 'PUBLIC' ? undefined : e.target.value })} disabled={readOnly}>
              <option value="PUBLIC">Anyone</option>
              <option value="CONNECTIONS">Connections only</option>
            </Select>
          </Field>
        ) : null}
        <Field label="Video title" optional>
          <Input value={str('videoTitle')} maxLength={200} readOnly={readOnly} onChange={(e) => set({ videoTitle: e.target.value })} />
        </Field>
      </>
    );
  } else if (p === 'bluesky') {
    body = (
      <Field label="Languages" optional hint="Comma-separated codes, e.g. en, de">
        <Input
          value={Array.isArray(o.langs) ? (o.langs as string[]).join(', ') : ''}
          readOnly={readOnly}
          onChange={(e) => set({ langs: e.target.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 3) })}
        />
      </Field>
    );
  }
  if (!body) return null;
  return (
    <section aria-labelledby={`po-${connection.id}`} className={cn('flex flex-col gap-4 rounded-xl border border-border p-4', issues.length && 'border-[color-mix(in_srgb,var(--danger)_45%,transparent)]')}>
      <h3 id={`po-${connection.id}`} className="text-[13px] font-medium">{PROVIDER_LABEL[p]} settings{required.size ? <span className="ml-2 text-xs font-normal text-muted">* required</span> : null}</h3>
      {body}
      {issues.length ? (
        <ul className="flex flex-col gap-1 text-xs text-danger" aria-live="polite">{issues.map((m, i) => <li key={i}>{m}</li>)}</ul>
      ) : null}
    </section>
  );
}
