// FAQ (server content, Base UI accordion). Answers are generated from the catalogue + capability data (content.ts) so they
// match the implementation; several answers can be open at once.
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui-v5/accordion';
import { Container, SectionHeading } from './section';
import { faq } from './content';

export function FaqSection() {
  const items = faq();
  return (
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-20 border-t border-v5-border py-20 sm:py-28">
      <Container className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
        <SectionHeading id="faq-title" eyebrow="FAQ" title="Questions, *answered*" lead="Trials, pricing, channels, teammates and limits." align="left" />
        <Accordion multiple className="rounded-[24px] border border-v5-border bg-v5-surface px-5 sm:px-7" data-testid="mkt-faq">
          {items.map((f) => (
            <AccordionItem key={f.id} value={f.id} data-testid={`mkt-faq-${f.id}`}>
              <AccordionTrigger>{f.q}</AccordionTrigger>
              <AccordionContent>{f.a.map((p, i) => <p key={i}>{p}</p>)}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Container>
    </section>
  );
}
