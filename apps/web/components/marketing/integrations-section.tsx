// "Connect your tools" (server; brief §4 Integrations — not "Trusted by"). Implemented networks and tools only. Tiles are
// icon, name and one line (user request 2026-11-10: no legend, badges or notes); the intro keeps the honesty disclosure
// that some go live only after provider approval (V5: never market an unimplemented connector as operational). Each
// tile still carries its status as `data-status` (integrations-data.ts) for tests and future use.
import { PlatformIcon } from '@/components/ui/platform-icon';
import { Container, SectionHeading } from './section';
import { TOOLS, networks } from './integrations-data';
import { ToolIcon } from './tool-icon';
import { Reveal } from '@/components/ui-v5/reveal';

const tile = 'mkt-lift flex h-full items-start gap-3 rounded-2xl border border-v5-border bg-v5-surface p-3.5 sm:p-4';

export function IntegrationsSection() {
  const nets = networks();
  return (
    <section id="integrations" aria-labelledby="integrations-title" className="scroll-mt-20 border-y border-v5-border bg-v5-raised/60 py-20 sm:py-28">
      <Container className="flex flex-col gap-10">
        <Reveal><SectionHeading id="integrations-title" eyebrow="Integrations" title="Connect your *tools*" lead="The networks and apps Relay connects to. Some go live as each network approves Relay’s access." /></Reveal>
        <div className="flex flex-col gap-4">
          <h3 className="text-[17px] font-bold text-v5-fg">Social networks</h3>
          <ul className="grid grid-cols-1 gap-3 min-[540px]:grid-cols-2 lg:grid-cols-5" data-testid="mkt-networks">
            {nets.map((n, i) => (
              <Reveal as="li" key={n.provider} effect="scale" delay={(i % 5) * 0.05} data-testid={`mkt-network-${n.provider}`} data-status={n.status}>
                <div className={tile}>
                  <PlatformIcon provider={n.provider} size="lg" decorative />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-[15px] font-semibold text-v5-fg">{n.name}</span>
                    <span className="text-[13px] leading-snug text-v5-muted">{n.does}</span>
                  </div>
                </div>
              </Reveal>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-4">
          <h3 className="text-[17px] font-bold text-v5-fg">Apps and content sources</h3>
          <ul className="grid grid-cols-1 gap-3 min-[540px]:grid-cols-2 lg:grid-cols-4" data-testid="mkt-tools">
            {TOOLS.map((t, i) => (
              <Reveal as="li" key={t.key} effect="scale" delay={(i % 4) * 0.05} data-testid={`mkt-tool-${t.key}`} data-status={t.status}>
                <div className={tile}>
                  <ToolIcon tool={t.key} />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-[15px] font-semibold text-v5-fg">{t.name}</span>
                    <span className="text-[13px] leading-snug text-v5-muted">{t.does}</span>
                  </div>
                </div>
              </Reveal>
            ))}
          </ul>
        </div>
      </Container>
    </section>
  );
}
