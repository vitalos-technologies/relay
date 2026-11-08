'use client';
// Rule builder: When (trigger) → If (conditions, all must match) → Then (actions) · scope, schedule, limits · Test
// (dry run over recent conversations; changes and sends nothing) · Save. Options outside the chosen policy are hidden;
// unavailable triggers/actions are shown with the reason.
import { useState } from 'react';
import { FlaskConical, Plus, Trash2 } from 'lucide-react';
import { PRIORITIES } from '@social-lite/core/contracts/v35-inbox';
import type {
  AutomationActionType, AutomationCatalogDto, AutomationPolicyDto, AutomationRuleDto, AutomationTrigger, ConditionField, RuleAction, RuleCondition, RuleTestResult,
} from '@social-lite/core/contracts/v35-automation';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Badge, Banner, Button, Checkbox, Drawer, ErrorNotice, Field, IconButton, Input, Select, Switch, useToast } from '@/components/ui';
import { ACTION_LABEL, CATEGORY_LABEL, FIELD_LABEL, TRIGGER_LABEL } from './labels';

const FIELDS_FOR: Record<AutomationTrigger, ConditionField[]> = {
  'inbox.message_received': ['category', 'sentiment', 'urgency', 'assigned', 'first_message', 'conversation_kind', 'channel_kind', 'language', 'priority', 'text_contains', 'labels'],
  'case.sla_nearing': ['priority', 'assigned', 'minutes_to_deadline'],
  'case.changed': ['case_change', 'priority', 'assigned'],
  'listening.alert': [],
  'content.approved': [],
};
const CHOICES: Partial<Record<ConditionField, string[]>> = {
  sentiment: ['negative', 'neutral', 'positive'], urgency: ['low', 'normal', 'high'], priority: [...PRIORITIES], conversation_kind: ['dm', 'comment', 'mention', 'review'],
  case_change: ['created', 'state', 'owner', 'breach', 'escalated'],
};
const opFor = (f: ConditionField): RuleCondition['op'] => (f === 'assigned' || f === 'first_message' ? 'is' : f === 'text_contains' || f === 'labels' ? 'contains_any' : f === 'minutes_to_deadline' ? 'lte' : 'in');
const defaultValue = (f: ConditionField): RuleCondition['value'] => (opFor(f) === 'is' ? false : opFor(f) === 'lte' ? 60 : []);

function defaultAction(t: AutomationActionType): RuleAction {
  switch (t) {
    case 'assign': return { type: 'assign', assignee_id: null, team_id: null };
    case 'set_priority': return { type: 'set_priority', priority: 'high' };
    case 'add_labels': return { type: 'add_labels', labels: [] };
    case 'add_note': return { type: 'add_note', body: '' };
    case 'create_case': return { type: 'create_case', title: null };
    case 'notify': return { type: 'notify', to: 'assignee' };
    case 'escalate': return { type: 'escalate', team_id: null, assignee_id: null, reason: null };
    case 'reply_saved': return { type: 'reply_saved', saved_reply_id: '', mode: 'private_message' };
    case 'reply_ai': return { type: 'reply_ai', mode: 'private_message' };
    case 'integration_job': return { type: 'integration_job', integration_id: '', kind: '' };
  }
}

export function RuleBuilder({ catalog, policies, rule, onClose, onSaved }: { catalog: AutomationCatalogDto; policies: AutomationPolicyDto[]; rule: AutomationRuleDto | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { session } = useSession();
  const teams = useApi<{ items: Array<{ id: string; name: string }> }>('/api/teams');
  const saved = useApi<{ items: Array<{ id: string; title: string; brand_id: string | null }> }>('/api/inbox/saved-replies');
  const [policyId, setPolicyId] = useState(rule?.policy_id ?? policies[0]?.id ?? '');
  const policy = policies.find((p) => p.id === policyId) ?? null;
  const [name, setName] = useState(rule?.name ?? '');
  const [trigger, setTrigger] = useState<AutomationTrigger>(rule?.trigger ?? 'inbox.message_received');
  const [minutesBefore, setMinutesBefore] = useState(String(rule?.trigger_params.minutes_before ?? 60));
  const [conditions, setConditions] = useState<RuleCondition[]>(rule?.conditions ?? []);
  const [actions, setActions] = useState<RuleAction[]>(rule?.actions ?? [{ type: 'add_labels', labels: [] }]);
  const [brands, setBrands] = useState<string[]>(rule?.scope.brand_ids ?? policy?.brand_ids ?? []);
  const [channels, setChannels] = useState<string[]>(rule?.scope.channel_ids ?? []);
  const [schedule, setSchedule] = useState(rule?.schedule.mode ?? 'always');
  const [perHour, setPerHour] = useState(String(rule?.limits.max_per_hour ?? 30));
  const [cooldown, setCooldown] = useState(String(rule?.limits.per_conversation_cooldown_minutes ?? 60));
  const [enabled, setEnabled] = useState(rule?.enabled ?? false);
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [test, setTest] = useState<RuleTestResult | null>(null);

  const allowed = policy?.allowed_actions ?? [];
  const actionAvail = new Map(catalog.actions.map((a) => [a.type, a]));
  const customerFacing = actions.some((a) => a.type === 'reply_saved' || a.type === 'reply_ai');
  const brandName = (id: string) => session.brands.find((b) => b.id === id)?.name ?? 'Brand';
  const chOptions = catalog.channels.filter((c) => policy?.channel_ids.includes(c.id) && brands.includes(c.brand_id));

  const body = () => ({
    policy_id: policyId, name: name.trim(), trigger, trigger_params: trigger === 'case.sla_nearing' ? { minutes_before: Number(minutesBefore) || 60 } : {},
    conditions, actions, scope: { brand_ids: brands.filter((b) => policy?.brand_ids.includes(b)), channel_ids: channels.filter((c) => chOptions.some((o) => o.id === c)) },
    schedule: { mode: schedule }, limits: { max_per_hour: Number(perHour) || 1, per_conversation_cooldown_minutes: Number(cooldown) || 0 }, enabled,
  });

  const run = async (kind: 'save' | 'test' | 'delete') => {
    setBusy(kind); setError(null);
    try {
      if (kind === 'test') { setTest(await api.post<RuleTestResult>('/api/automation/rules/test', body())); return; }
      if (kind === 'delete') { await api.del(`/api/automation/rules/${rule!.id}`); toast.success('Rule deleted'); onSaved(); return; }
      if (rule) await api.put(`/api/automation/rules/${rule.id}?version=${rule.version}`, body()); else await api.post('/api/automation/rules', body());
      toast.success('Rule saved');
      onSaved();
    } catch (e) { setError(e); } finally { setBusy(null); }
  };

  const setAction = (i: number, a: RuleAction) => setActions(actions.map((x, j) => (j === i ? a : x)));
  const noReason = !name.trim() ? 'Name the rule' : !brands.length ? 'Choose a brand' : !actions.length ? 'Add an action' : null;

  return (
    <Drawer open onOpenChange={(v) => { if (!v) onClose(); }} title={rule ? 'Edit rule' : 'New rule'} footer={<>
      {rule ? <Button variant="ghost" className="mr-auto text-danger" loading={busy === 'delete'} onClick={() => void run('delete')}>Delete</Button> : null}
      <Button variant="secondary" icon={<FlaskConical aria-hidden className="size-4" />} loading={busy === 'test'} onClick={() => void run('test')} disabledReason={noReason}>Test</Button>
      <Button variant="primary" loading={busy === 'save'} onClick={() => void run('save')} disabledReason={noReason}>Save</Button>
    </>}>
      <div className="flex flex-col gap-5 text-[13px]">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Route order questions" /></Field>
        <Field label="Policy">
          <Select value={policyId} onChange={(e) => { setPolicyId(e.target.value); const p = policies.find((x) => x.id === e.target.value); setBrands(p?.brand_ids ?? []); setChannels([]); }}>
            {policies.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status !== 'active' ? ` (${p.status})` : ''}</option>)}
          </Select>
        </Field>

        <section className="flex flex-col gap-3 rounded-xl border border-border p-3">
          <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-subtle">When</h3>
          <Select aria-label="Trigger" value={trigger} onChange={(e) => { setTrigger(e.target.value as AutomationTrigger); setConditions([]); }}>
            {catalog.triggers.map((t) => <option key={t.trigger} value={t.trigger} disabled={!t.available}>{TRIGGER_LABEL[t.trigger]}{t.reason ? ` — ${t.reason}` : ''}</option>)}
          </Select>
          {trigger === 'case.sla_nearing' ? <Field label="Minutes before the deadline"><Input type="number" min={5} max={1440} value={minutesBefore} onChange={(e) => setMinutesBefore(e.target.value)} /></Field> : null}
          {trigger === 'inbox.message_received' ? <p className="text-xs text-muted">Messages are classified first (category, sentiment, urgency).</p> : null}
        </section>

        <section className="flex flex-col gap-3 rounded-xl border border-border p-3">
          <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-subtle">If · all must match</h3>
          {conditions.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select aria-label="Field" className="w-full sm:w-44" value={c.field} onChange={(e) => { const f = e.target.value as ConditionField; setConditions(conditions.map((x, j) => (j === i ? { field: f, op: opFor(f), value: defaultValue(f) } : x))); }}>
                {FIELDS_FOR[trigger].map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
              </Select>
              <ConditionValue c={c} catalog={catalog} onChange={(v) => setConditions(conditions.map((x, j) => (j === i ? { ...x, ...v } : x)))} />
              <IconButton label="Remove condition" icon={<Trash2 className="size-4" />} variant="ghost" onClick={() => setConditions(conditions.filter((_, j) => j !== i))} />
            </div>
          ))}
          {FIELDS_FOR[trigger].length ? (
            <Button size="sm" variant="ghost" icon={<Plus aria-hidden className="size-4" />} className="self-start" onClick={() => { const f = FIELDS_FOR[trigger][0]!; setConditions([...conditions, { field: f, op: opFor(f), value: defaultValue(f) }]); }}>Add condition</Button>
          ) : null}
        </section>

        <section className="flex flex-col gap-3 rounded-xl border border-border p-3">
          <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-subtle">Then</h3>
          {customerFacing ? <Banner tone="warn">Sends to customers only for categories the policy allows. Anything else is escalated to a person.</Banner> : null}
          {actions.map((a, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-lg bg-sunken p-2.5">
              <div className="flex items-center gap-2">
                <Select aria-label="Action" value={a.type} onChange={(e) => setAction(i, defaultAction(e.target.value as AutomationActionType))}>
                  {allowed.map((t) => <option key={t} value={t} disabled={actionAvail.get(t)?.available === false}>{ACTION_LABEL[t]}{actionAvail.get(t)?.reason ? ` — ${actionAvail.get(t)!.reason}` : ''}</option>)}
                </Select>
                <IconButton label="Remove action" icon={<Trash2 className="size-4" />} variant="ghost" onClick={() => setActions(actions.filter((_, j) => j !== i))} />
              </div>
              <ActionParams a={a} onChange={(x) => setAction(i, x)} teams={teams.data?.items ?? []} saved={(saved.data?.items ?? []).filter((s) => !s.brand_id || brands.includes(s.brand_id))} catalog={catalog} />
            </div>
          ))}
          {actions.length < 10 && allowed.length ? <Button size="sm" variant="ghost" icon={<Plus aria-hidden className="size-4" />} className="self-start" onClick={() => setActions([...actions, defaultAction(allowed[0]!)])}>Add action</Button> : null}
        </section>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">Scope</legend>
          {(policy?.brand_ids ?? []).map((b) => <Checkbox key={b} label={brandName(b)} checked={brands.includes(b)} onChange={(e) => setBrands(e.target.checked ? [...brands, b] : brands.filter((x) => x !== b))} />)}
          {trigger === 'inbox.message_received' && chOptions.length > 1 ? (
            <div className="mt-1 flex flex-col gap-2 pl-1">
              <p className="text-xs text-muted">Channels (none = all channels in the policy)</p>
              {chOptions.map((c) => <Checkbox key={c.id} label={c.display_name} checked={channels.includes(c.id)} onChange={(e) => setChannels(e.target.checked ? [...channels, c.id] : channels.filter((x) => x !== c.id))} />)}
            </div>
          ) : null}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Runs">
            <Select value={schedule} onChange={(e) => setSchedule(e.target.value as typeof schedule)}>
              <option value="always">Always</option><option value="business_hours">Business hours</option><option value="outside_business_hours">Outside business hours</option>
            </Select>
          </Field>
          <Field label="Max per hour"><Input type="number" min={1} max={1000} value={perHour} onChange={(e) => setPerHour(e.target.value)} /></Field>
          <Field label="Cooldown (min)" hint="Per conversation"><Input type="number" min={0} max={10080} value={cooldown} onChange={(e) => setCooldown(e.target.value)} /></Field>
        </div>
        <Switch label="Enabled" description={policy?.status !== 'active' ? 'Runs only while its policy is active.' : undefined} checked={enabled} onCheckedChange={setEnabled} />
        {error ? <ErrorNotice error={error} /> : null}
        {test ? <TestResult r={test} /> : null}
      </div>
    </Drawer>
  );
}

function ConditionValue({ c, catalog, onChange }: { c: RuleCondition; catalog: AutomationCatalogDto; onChange: (v: Partial<RuleCondition>) => void }) {
  const choices = c.field === 'category' ? [...catalog.categories] : c.field === 'channel_kind' ? [...new Set(catalog.channels.map((x) => x.kind))] : CHOICES[c.field];
  if (c.op === 'is') return <Select aria-label="Value" className="w-28" value={String(c.value)} onChange={(e) => onChange({ value: e.target.value === 'true' })}><option value="true">Yes</option><option value="false">No</option></Select>;
  if (c.op === 'lte') return <Input aria-label="Minutes" type="number" className="w-28" min={0} value={String(c.value)} onChange={(e) => onChange({ value: Number(e.target.value) })} />;
  const list = Array.isArray(c.value) ? c.value : [];
  if (choices?.length) {
    return (
      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5" role="group" aria-label={FIELD_LABEL[c.field]}>
        {choices.map((v) => {
          const on = list.includes(v);
          return <button key={v} type="button" aria-pressed={on} onClick={() => onChange({ value: on ? list.filter((x) => x !== v) : [...list, v] })}
            className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-[var(--accent-text)] bg-accent-soft text-accent-text' : 'border-border text-muted hover:bg-raised'}`}>{CATEGORY_LABEL[v] ?? v}</button>;
        })}
      </div>
    );
  }
  return <Input aria-label="Values" className="min-w-0 flex-1" placeholder="Comma-separated" value={list.join(', ')} onChange={(e) => onChange({ value: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />;
}

function ActionParams({ a, onChange, teams, saved, catalog }: { a: RuleAction; onChange: (a: RuleAction) => void; teams: Array<{ id: string; name: string }>; saved: Array<{ id: string; title: string }>; catalog: AutomationCatalogDto }) {
  const teamSelect = (value: string | null | undefined, set: (v: string | null) => void) => (
    <Select aria-label="Team" value={value ?? ''} onChange={(e) => set(e.target.value || null)}>
      <option value="">No team</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </Select>
  );
  const mode = (v: 'public_reply' | 'private_message', set: (m: 'public_reply' | 'private_message') => void) => (
    <Select aria-label="Reply type" value={v} onChange={(e) => set(e.target.value as typeof v)}><option value="private_message">Private message</option><option value="public_reply">Public reply</option></Select>
  );
  switch (a.type) {
    case 'assign': return teamSelect(a.team_id, (v) => onChange({ ...a, team_id: v }));
    case 'escalate': return <div className="grid gap-2 sm:grid-cols-2">{teamSelect(a.team_id, (v) => onChange({ ...a, team_id: v }))}<Input aria-label="Reason" placeholder="Reason (optional)" value={a.reason ?? ''} maxLength={200} onChange={(e) => onChange({ ...a, reason: e.target.value || null })} /></div>;
    case 'set_priority': return <Select aria-label="Priority" value={a.priority} onChange={(e) => onChange({ ...a, priority: e.target.value as typeof a.priority })}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</Select>;
    case 'add_labels': return <Input aria-label="Labels" placeholder="Labels, comma-separated" value={a.labels.join(', ')} onChange={(e) => onChange({ ...a, labels: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />;
    case 'add_note': return <Input aria-label="Note" placeholder="Internal note" value={a.body} maxLength={1000} onChange={(e) => onChange({ ...a, body: e.target.value })} />;
    case 'create_case': return <Input aria-label="Case title" placeholder="Case title (optional)" value={a.title ?? ''} maxLength={200} onChange={(e) => onChange({ ...a, title: e.target.value || null })} />;
    case 'notify': return <Select aria-label="Notify" value={a.to} onChange={(e) => onChange({ ...a, to: e.target.value as typeof a.to })}><option value="assignee">Assignee</option><option value="case_owner">Case owner</option></Select>;
    case 'reply_saved': return (
      <div className="grid gap-2 sm:grid-cols-2">
        <Select aria-label="Saved reply" value={a.saved_reply_id} onChange={(e) => onChange({ ...a, saved_reply_id: e.target.value })}><option value="">Choose saved reply…</option>{saved.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</Select>
        {mode(a.mode, (m) => onChange({ ...a, mode: m }))}
      </div>
    );
    case 'reply_ai': return <div className="flex flex-col gap-1.5">{mode(a.mode, (m) => onChange({ ...a, mode: m }))}<p className="text-xs text-muted">Sent only if the draft is fully supported by the policy’s approved knowledge; otherwise escalated.</p></div>;
    case 'integration_job': return (
      <Select aria-label="Integration action" value={`${a.integration_id}|${a.kind}`} onChange={(e) => { const [integration_id, kind] = e.target.value.split('|'); onChange({ ...a, integration_id: integration_id ?? '', kind: kind ?? '' }); }}>
        <option value="|">Choose…</option>
        {catalog.integration_jobs.map((j) => <option key={`${j.integration_id}|${j.kind}`} value={`${j.integration_id}|${j.kind}`} disabled={!j.available}>{j.display_name}{j.reason ? ` — ${j.reason}` : ''}</option>)}
      </Select>
    );
  }
}

function TestResult({ r }: { r: RuleTestResult }) {
  return (
    <section aria-label="Test result" className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <p className="font-medium">Test · {r.matched} of {r.evaluated} recent matched</p>
      <p className="text-xs text-muted">Dry run: nothing was changed or sent.</p>
      <ul className="flex flex-col gap-1.5">
        {r.samples.slice(0, 10).map((s) => (
          <li key={s.conversation_id} className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge tone={s.matched ? 'success' : 'neutral'} className="h-5 px-1.5 text-[11px]">{s.matched ? 'Match' : 'No match'}</Badge>
            <span className="text-muted">{CATEGORY_LABEL[s.category] ?? s.category}</span>
            {s.actions.map((a, i) => <span key={i} className={`min-w-0 break-words ${a.status === 'would_run' ? 'text-info' : 'text-warn'}`}>{ACTION_LABEL[a.type]}: {a.status === 'would_run' ? 'would run' : a.detail}</span>)}
          </li>
        ))}
      </ul>
    </section>
  );
}
