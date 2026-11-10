// Capability strip (server): Plan · Engage · Understand · Collaborate.
import { CalendarDays, ChartNoAxesColumnIncreasing, MessagesSquare, UsersRound } from 'lucide-react';
import { CAPABILITIES } from './content';
import { Container, IconTile } from './section';
import { Reveal } from '@/components/ui-v5/reveal';

const ICON = { plan: CalendarDays, engage: MessagesSquare, understand: ChartNoAxesColumnIncreasing, collaborate: UsersRound } as const;

export function CapabilityStrip() {
  return (
    <section aria-label="What Relay does" className="border-y border-v5-border bg-v5-surface">
      <Container>
        <ul className="grid grid-cols-1 divide-y divide-v5-border min-[480px]:grid-cols-2 min-[480px]:divide-y-0 lg:grid-cols-4 lg:divide-x">
          {CAPABILITIES.map((c, i) => {
            const Icon = ICON[c.id];
            return (
              <Reveal as="li" key={c.id} effect="rise" delay={i * 0.07} className="flex items-start gap-4 px-2 py-6 lg:px-6 lg:py-8">
                <IconTile><Icon /></IconTile>
                <span>
                  <span className="block text-[17px] font-bold text-v5-fg">{c.label}</span>
                  <span className="mt-0.5 block text-[14px] leading-snug text-v5-muted">{c.text}</span>
                </span>
              </Reveal>
            );
          })}
        </ul>
      </Container>
    </section>
  );
}
