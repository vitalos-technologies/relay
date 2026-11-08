'use client';
// Policy editor: every bound the brief requires is a required field (brands + channels, allowed actions, approved
// sources, reply categories, limits, escalation, expiry). Refunds, complaints and sensitive messages are never offered
// as reply categories. Saving an active policy pauses it until it is activated again.
import { useMemo, useState } from 'react';
import { MESSAGE_CATEGORIES, type KnowledgeSourceDto, type MessageCategory } from '@social-lite/core/contracts/v35-ai';
import { AUTOMATION_ACTIONS, type AutomationActionType, type AutomationCatalogDto, type AutomationPolicyDto } from '@social-lite/core/contracts/v35-automation';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Banner, Button, Checkbox, Drawer, ErrorNotice, Field, Input, Select, Switch, useToast } from '@/components/ui';
import { ACTION_LABEL, CATEGORY_LABEL } from './labels';

const REPLYABLE = MESSAGE_CATEGORIES.filter((c) => !['refund', 'complaint', 'sensitive', 'spam'].includes(c));
const day = (d: Date) => d.toISOString().slice(0, 10);

function Checks<T extends string>({ legend, options, value, onChange }: { legend: string; options: Array<{ value: T; label: string; hint?: string }>; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[13px] font-medium">{legend}</legend>
      {options.length ? options.map((o) => (
        <Checkbox key={o.value} label={o.label} description={o.hint} checked={value.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))} />
      )) : <p className="text-xs text-muted">Nothing available.</p>}
    </fieldset>
  );
}

export function PolicyEditor({ catalog, policy, onClose, onSaved }: { catalog: AutomationCatalogDto; policy: AutomationPolicyDto | null; onClose: () => void; onSaved: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const teams = useApi<{ items: Array<{ id: string; name: string }> }>('/api/teams');
  const knowledge = useApi<{ items: KnowledgeSourceDto[] }>('/api/assistant/knowledge');
  const [name, setName] = useState(policy?.name ?? 'Customer care');
  const [brands, setBrands] = useState<string[]>(policy?.brand_ids ?? (session.brands[0] ? [session.brands[0].id] : []));
  const [channels, setChannels] = useState<string[]>(policy?.channel_ids ?? []);
  const [actions, setActions] = useState<AutomationActionType[]>(policy?.allowed_actions ?? ['assign', 'add_labels', 'set_priority', 'escalate', 'add_note']);
  const [cats, setCats] = useState<MessageCategory[]>(policy?.reply_categories ?? []);
  const [ks, setKs] = useState<string[]>(policy?.knowledge_source_ids ?? []);
  const [perHour, setPerHour] = useState(String(policy?.limits.max_actions_per_hour ?? 60));
  const [perDay, setPerDay] = useState(String(policy?.limits.max_auto_replies_per_day ?? 0));
  const [tokens, setTokens] = useState(String(policy?.limits.monthly_token_budget ?? 0));
  const [negative, setNegative] = useState(policy?.escalation.negative_sentiment ?? true);
  const [keywords, setKeywords] = useState((policy?.escalation.keywords ?? ['lawyer', 'legal']).join(', '));
  const [team, setTeam] = useState(policy?.escalation.team_id ?? '');
  const [expires, setExpires] = useState(() => (policy ? day(new Date(policy.expires_at)) : day(new Date(Date.now() + 90 * 86_400_000))));
  const [review, setReview] = useState(policy?.review_by ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const chOptions = useMemo(() => catalog.channels.filter((c) => brands.includes(c.brand_id)), [catalog.channels, brands]);
  const kOptions = (knowledge.data?.items ?? []).filter((k) => brands.includes(k.brand_id));
  const replies = actions.includes('reply_saved') || actions.includes('reply_ai');

  const save = async () => {
    setBusy(true); setError(null);
    const body = {
      name: name.trim(), brand_ids: brands, channel_ids: channels.filter((c) => chOptions.some((o) => o.id === c)), allowed_actions: actions,
      knowledge_source_ids: ks.filter((k) => kOptions.some((o) => o.id === k)), reply_categories: replies ? cats : [],
      limits: { max_actions_per_hour: Number(perHour) || 1, max_auto_replies_per_day: replies ? Number(perDay) || 0 : 0, monthly_token_budget: actions.includes('reply_ai') ? Number(tokens) || 0 : 0 },
      escalation: { negative_sentiment: negative, keywords: keywords.split(',').map((k) => k.trim()).filter((k) => k.length >= 2), team_id: team || null },
      expires_at: new Date(`${expires}T23:59:00`).toISOString(), review_by: review || null,
    };
    try {
      if (policy) await api.patch(`/api/automation/policies/${policy.id}`, body); else await api.post('/api/automation/policies', body);
      toast.success(policy?.status === 'active' ? 'Saved · policy paused until you activate it' : 'Saved');
      onSaved();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Drawer open onOpenChange={(v) => { if (!v) onClose(); }} title={policy ? 'Edit policy' : 'New policy'} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} onClick={() => void save()} disabledReason={!name.trim() ? 'Name it' : !brands.length ? 'Choose a brand' : !channels.length ? 'Choose a channel' : !actions.length ? 'Allow at least one action' : null}>Save</Button>
    </>}>
      <div className="flex flex-col gap-5 text-[13px]">
        {policy?.status === 'active' ? <Banner tone="warn">Saving pauses this policy until it is activated again.</Banner> : null}
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Checks legend="Brands" options={session.brands.map((b) => ({ value: b.id, label: b.name }))} value={brands} onChange={setBrands} />
        <Checks legend="Channels" options={chOptions.map((c) => ({ value: c.id, label: `${c.display_name}${c.is_simulated ? ' (simulated)' : ''}` }))} value={channels} onChange={setChannels} />
        <Checks legend="Allowed actions" options={AUTOMATION_ACTIONS.map((a) => ({ value: a, label: ACTION_LABEL[a], hint: a === 'reply_saved' || a === 'reply_ai' ? 'Sends to customers' : undefined }))} value={actions} onChange={setActions} />
        {replies ? (
          <>
            <Checks legend="Messages that may get an automatic reply" options={REPLYABLE.map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c }))} value={cats} onChange={setCats} />
            <p className="-mt-3 text-xs text-muted">Refunds, complaints and sensitive messages always go to a person.</p>
            <Field label="Automatic replies per day"><Input type="number" min={1} max={10000} value={perDay} onChange={(e) => setPerDay(e.target.value)} /></Field>
          </>
        ) : null}
        {actions.includes('reply_ai') ? (
          <>
            <Checks legend="Approved knowledge for AI replies" options={kOptions.map((k) => ({ value: k.id, label: k.title, hint: k.stale ? 'Review overdue' : undefined }))} value={ks} onChange={setKs} />
            <Field label="Monthly token budget"><Input type="number" min={1} value={tokens} onChange={(e) => setTokens(e.target.value)} /></Field>
          </>
        ) : null}
        <Field label="Actions per hour"><Input type="number" min={1} max={10000} value={perHour} onChange={(e) => setPerHour(e.target.value)} /></Field>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-[13px] font-medium">Escalate to a person</legend>
          <Switch label="Negative messages" checked={negative} onCheckedChange={setNegative} />
          <Field label="Keywords" hint="Comma-separated"><Input value={keywords} onChange={(e) => setKeywords(e.target.value)} maxLength={500} /></Field>
          <Field label="Escalation team" optional>
            <Select value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">No team</option>
              {(teams.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Expires" hint="Within 12 months"><Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
          <Field label="Review by" optional><Input type="date" value={review} onChange={(e) => setReview(e.target.value)} /></Field>
        </div>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Drawer>
  );
}
