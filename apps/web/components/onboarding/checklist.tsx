'use client';
// V3.1 §7 onboarding checklist on Overview (flag v31.onboarding_checklist). Progress is derived server-side from real
// data (GET /api/onboarding), so it resumes anywhere and never claims a step that didn't happen. Role-adapted: steps
// the viewer can't do show who to ask; not_applicable steps are hidden. Per connection: five readiness checks.
import { useState } from 'react';
import { ChevronDown, Circle, CircleCheck, CircleDashed, CircleMinus, CircleX, ListChecks, TriangleAlert, X } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import type { DiagnosticStatus, OnboardingState, OnboardingStep } from '@social-lite/core/contracts/v31-gov';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useFlag } from '@/lib/client/flags';
import { Badge, Button, Card, IconButton, LinkButton, PlatformIcon, cn, useToast } from '@/components/ui';

const CHECK_LABEL: Record<keyof OnboardingState['connections'][number]['checks'], string> = {
  authorization: 'Authorized', selected_account: 'Account selected', posting_permission: 'Can post', supported_formats: 'Formats known', analytics_permission: 'Analytics',
};

// Older server hrefs that have a better home in the V3 app.
function fixHref(href: string): string {
  if (href === '/posts') return '/compose';
  if (href === '/settings?tab=team') return '/team/invitations';
  return href;
}

/** Shared state for the checklist and the header's resume button. */
export function useOnboarding() {
  const on = useFlag('v31.onboarding_checklist');
  const { data, setData } = useApi<OnboardingState>(on ? '/api/onboarding' : null);
  return { on, data, setData };
}
type Ob = ReturnType<typeof useOnboarding>;

export function OnboardingChecklist({ ob }: { ob: Ob }) {
  const { on, data, setData } = ob;
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [showConns, setShowConns] = useState(false);
  if (!on || !data || data.dismissed || data.complete) return null;
  const patch = async (k: string, body: Record<string, unknown>) => {
    setBusy(k);
    try { setData(await api.patch<OnboardingState>('/api/onboarding', body)); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const steps = data.steps.filter((s) => s.status !== 'not_applicable');
  const pct = data.progress.total ? Math.round((data.progress.done / data.progress.total) * 100) : 0;
  return (
    <Card aria-labelledby="ob-title" data-testid="onboarding">
      <div className="flex items-start gap-3 px-4 pt-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-tile text-tile-fg"><ListChecks aria-hidden className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <h2 id="ob-title" className="text-[14px] font-semibold">Get set up</h2>
          <p className="text-xs text-muted tabular">{data.progress.done} of {data.progress.total} done</p>
        </div>
        <IconButton size="sm" label="Hide checklist" icon={<X aria-hidden className="size-4" />} onClick={() => void patch('dismiss', { dismissed: true })} />
      </div>
      <div className="mx-4 mt-3 h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Setup progress">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <ol className="mt-2 flex flex-col px-2 pb-2">
        {steps.map((s) => <StepRow key={s.key} step={s} next={data.next?.key === s.key} busy={busy} onPatch={patch} />)}
      </ol>
      {data.connections.length ? (
        <div className="border-t border-border">
          <button type="button" aria-expanded={showConns} onClick={() => setShowConns(!showConns)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-[13px] font-medium hover:bg-raised/60">
            Connection readiness
            <span className="text-xs font-normal text-muted tabular">{data.connections.filter((c) => Object.values(c.checks).every((v) => v === 'ok' || v === 'not_applicable')).length}/{data.connections.length} ready</span>
            <ChevronDown aria-hidden className={cn('ml-auto size-4 text-muted transition-transform', showConns && 'rotate-180')} />
          </button>
          {showConns ? (
            <ul className="flex flex-col gap-3 px-4 pb-4" aria-label="Connection readiness">
              {data.connections.map((c) => (
                <li key={c.connection_id}>
                  <p className="mb-1.5 flex items-center gap-2 text-[13px] font-medium"><PlatformIcon provider={c.provider} size="xs" />{c.display_name}<span className="text-xs font-normal text-muted">{PROVIDER_LABEL[c.provider]}</span></p>
                  <ul className="flex flex-wrap gap-1.5">
                    {(Object.keys(CHECK_LABEL) as Array<keyof typeof CHECK_LABEL>).map((k) => <li key={k}><CheckChip status={c.checks[k]} label={CHECK_LABEL[k]} /></li>)}
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function StepRow({ step, next, busy, onPatch }: { step: OnboardingStep; next: boolean; busy: string | null; onPatch: (k: string, b: Record<string, unknown>) => Promise<void> }) {
  const done = step.status === 'done' || step.status === 'skipped';
  return (
    <li className={cn('flex flex-wrap items-center gap-3 rounded-lg px-2 py-2', next && 'bg-raised')} data-step={step.key} data-status={step.status}>
      {step.status === 'done' ? <CircleCheck aria-label="Done" className="size-5 shrink-0 text-success" />
        : step.status === 'skipped' ? <CircleMinus aria-label="Skipped" className="size-5 shrink-0 text-subtle" />
          : <Circle aria-label="To do" className={cn('size-5 shrink-0', next ? 'text-accent-text' : 'text-subtle')} />}
      <div className="min-w-[11rem] flex-1">
        <p className={cn('text-[13px]', done ? 'text-muted' : 'font-medium')}>{step.title}{step.optional ? <span className="ml-1.5 text-xs font-normal text-subtle no-underline">Optional</span> : null}</p>
        {!done && step.ask ? <p className="text-xs text-muted">{step.ask}</p> : null}
      </div>
      {!done && step.action ? (
        <span className="flex flex-wrap gap-1.5 max-sm:ml-8 max-sm:max-w-[calc(100%-2rem)]">
          {step.key === 'brand_defaults' ? <Button size="sm" variant="quiet" loading={busy === step.key} onClick={() => void onPatch(step.key, { acknowledge: 'brand_defaults' })}>Mark reviewed</Button> : null}
          {step.key === 'invite_teammates' ? <Button size="sm" variant="quiet" loading={busy === step.key} onClick={() => void onPatch(step.key, { acknowledge: 'invite_teammates_skipped' })}>Skip</Button> : null}
          <LinkButton size="sm" variant={next ? 'primary' : 'secondary'} href={fixHref(step.action.href)}>{step.action.label}</LinkButton>
        </span>
      ) : null}
    </li>
  );
}

function CheckChip({ status, label }: { status: DiagnosticStatus; label: string }) {
  const icon = status === 'ok' ? <CircleCheck aria-hidden className="size-3.5" />
    : status === 'warning' ? <TriangleAlert aria-hidden className="size-3.5" />
      : status === 'failing' ? <CircleX aria-hidden className="size-3.5" />
        : <CircleDashed aria-hidden className="size-3.5" />;
  const tone = status === 'ok' ? 'success' : status === 'warning' ? 'warn' : status === 'failing' ? 'danger' : 'neutral';
  const word = status === 'ok' ? '' : status === 'not_applicable' ? ' · n/a' : status === 'unknown' ? ' · unknown' : status === 'warning' ? ' · check' : ' · missing';
  return <Badge tone={tone} icon={icon}>{label}{word}</Badge>;
}

/** Overview header link to bring a hidden checklist back. */
export function ResumeOnboarding({ ob }: { ob: Ob }) {
  const { on, data, setData } = ob;
  if (!on || !data || !data.dismissed || data.complete) return null;
  return (
    <Button variant="ghost" icon={<ListChecks aria-hidden className="size-4" />} onClick={async () => setData(await api.patch<OnboardingState>('/api/onboarding', { dismissed: false }))}>
      Setup {data.progress.done}/{data.progress.total}
    </Button>
  );
}
