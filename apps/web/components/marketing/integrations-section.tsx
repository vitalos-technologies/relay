// "Connect your tools" (server; brief §4 Integrations — not "Trusted by"). Implemented networks and tools only, with honest
// status labels; icons identify services and imply no endorsement.
import { CircleCheck, CircleDashed, CircleAlert } from 'lucide-react';
import { PlatformIcon } from '@/components/ui/platform-icon';
import { Badge } from '@/components/ui-v5/badge';
import { Container, SectionHeading } from './section';
import { STATUS_HELP, STATUS_LABEL, TOOLS, networks, type IntegrationStatus } from './integrations-data';
import { ToolIcon } from './tool-icon';

const TONE: Record<IntegrationStatus, 'success' | 'neutral' | 'warn'> = { available: 'success', provider_access: 'neutral', limited: 'warn' };
const STATUS_ICON = { available: CircleCheck, provider_access: CircleDashed, limited: CircleAlert } as const;

function Status({ status }: { status: IntegrationStatus }) {
  const Icon = STATUS_ICON[status];
  return <Badge variant={TONE[status]} data-status={status}><Icon aria-hidden />{STATUS_LABEL[status]}</Badge>;
}

export function IntegrationsSection() {
  const nets = networks();
  return (
    <section id="integrations" aria-labelledby="integrations-title" className="scroll-mt-20 border-y border-v5-border bg-v5-raised/60 py-20 sm:py-28">
      <Container className="flex flex-col gap-10">
        <SectionHeading id="integrations-title" eyebrow="Integrations" title="Connect your *tools*" lead="The networks and apps Relay works with today, and what each one still needs." />
        <dl className="mx-auto grid max-w-3xl grid-cols-1 gap-3 text-[14px] sm:grid-cols-3" aria-label="Status labels">
          {(Object.keys(STATUS_LABEL) as IntegrationStatus[]).map((s) => (
            <div key={s} className="flex flex-col gap-1.5 rounded-2xl border border-v5-border bg-v5-surface p-3">
              <dt><Status status={s} /></dt>
              <dd className="text-[13px] leading-snug text-v5-muted">{STATUS_HELP[s]}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-4">
          <h3 className="text-[17px] font-bold text-v5-fg">Social networks</h3>
          <ul className="grid grid-cols-1 gap-3 min-[540px]:grid-cols-2 lg:grid-cols-5" data-testid="mkt-networks">
            {nets.map((n) => (
              <li key={n.provider} className="flex flex-col gap-2 rounded-2xl border border-v5-border bg-v5-surface p-3.5 sm:gap-3 sm:p-4" data-testid={`mkt-network-${n.provider}`}>
                <div className="flex items-center gap-3">
                  <PlatformIcon provider={n.provider} size="lg" decorative />
                  <span className="text-[15px] font-semibold text-v5-fg">{n.name}</span>
                </div>
                <p className="text-[13px] leading-snug text-v5-muted">{n.does}</p>
                <div className="mt-auto flex flex-col items-start gap-1">
                  <Status status={n.status} />
                  <span className="text-[12px] text-v5-muted">{n.note}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-4">
          <h3 className="text-[17px] font-bold text-v5-fg">Apps and content sources</h3>
          <ul className="grid grid-cols-1 gap-3 min-[540px]:grid-cols-2 lg:grid-cols-4" data-testid="mkt-tools">
            {TOOLS.map((t) => (
              <li key={t.key} className="flex items-start gap-3 rounded-2xl border border-v5-border bg-v5-surface p-3.5 sm:p-4" data-testid={`mkt-tool-${t.key}`}>
                <ToolIcon tool={t.key} />
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-[15px] font-semibold text-v5-fg">{t.name}</span>
                  <span className="text-[13px] leading-snug text-v5-muted">{t.does}</span>
                  <span className="flex flex-wrap items-center gap-1.5"><Status status={t.status} />{t.plan === 'professional' ? <Badge variant="primary">Professional</Badge> : null}</span>
                  <span className="text-[12px] text-v5-muted">{t.note}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-center text-[13px] text-v5-muted">Names and logos belong to their owners and identify the services Relay connects to. No endorsement or partnership is implied.</p>
      </Container>
    </section>
  );
}
