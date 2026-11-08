// Product demonstrations (server shell): four substantial cards — publishing, inbox, analytics + listening, AI (anchor #ai).
// Each: title, one useful sentence, a small interactive preview with example content, an "Explore" inline preview that
// lists what is included and what still needs provider access, and the plan that includes it.
import type { ReactNode } from 'react';
import { CalendarClock, ChartLine, Inbox, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui-v5/badge';
import { ButtonLink } from '@/components/ui-v5/button';
import { Reveal } from '@/components/ui-v5/reveal';
import { AiDemo, AnalyticsDemo, ComposerDemo, InboxDemo } from './demos';
import { ExploreDialog } from './explore-dialog';
import { Container, IconTile, SectionHeading } from './section';
import { TRIAL_DAYS } from './plan-data';

interface Demo {
  id: string; anchor?: string; icon: ReactNode; title: string; text: string; plan: string; explore: string;
  includes: string[]; access: string; preview: ReactNode;
}

const DEMOS: Demo[] = [
  {
    id: 'publishing', icon: <CalendarClock />, title: 'Publishing and scheduling', text: 'Write once, tailor it per network and schedule it on a shared calendar — with approvals before anything goes out.',
    plan: 'Every plan', explore: 'Explore publishing',
    includes: ['Planner and calendar across brands and channels', 'Per-network checks for length, media and required fields', 'Single-stage approval on Standard; multi-step approvals on Professional', 'Media library with crops per network'],
    access: 'Live publishing to each network starts once that network approves Relay’s access — see Connect your tools.',
    preview: <ComposerDemo />,
  },
  {
    id: 'inbox', icon: <Inbox />, title: 'Social inbox and customer care', text: 'Comments, messages, mentions and reviews from supported networks in one queue, with assignment and notes.',
    plan: 'Every plan · advanced care on Professional', explore: 'Explore the inbox',
    includes: ['One queue for supported conversation types', 'Assignment, internal notes and reply drafts', 'Reply windows and network rules enforced at send time', 'Service levels and routing on Professional'],
    access: 'Facebook, Instagram, Threads and WhatsApp conversations need Meta approval; X, LinkedIn and TikTok inboxes aren’t available yet.',
    preview: <InboxDemo />,
  },
  {
    id: 'analytics', icon: <ChartLine />, title: 'Analytics and listening', text: 'See what works by channel and post, with data coverage shown — and follow topics on the sources you activate.',
    plan: 'Standard analytics on every plan · reports and listening on Professional', explore: 'Explore analytics',
    includes: ['Channel, content and audience views', 'Coverage and freshness shown; missing data never counted as zero', 'Saved reports and exports on Professional', 'Listening on activated, connected sources'],
    access: 'Listening covers the sources you connect and activate. Paid third-party data licences aren’t included.',
    preview: <AnalyticsDemo />,
  },
  {
    id: 'ai-assistant', anchor: 'ai', icon: <Sparkles />, title: 'AI assistant', text: 'Ask Relay to plan a week, turn a brief into drafts or answer unread messages. It works within your permissions and saves drafts for review.',
    plan: 'AI drafting on every plan · multi-step workflows on Professional', explore: 'Explore the assistant',
    includes: ['Suggested tasks based on your brands, accounts and content', 'Visible progress for each step it takes', 'Drafts saved through the normal review flow', 'Publishing and replies always need approval'],
    access: 'AI usage counts against a monthly allowance shown in Compare plans.',
    preview: <AiDemo />,
  },
];

export function ProductDemos() {
  return (
    <section id="product" aria-labelledby="product-title" className="scroll-mt-20 py-20 sm:py-28">
      <Container className="flex flex-col gap-12">
        <SectionHeading id="product-title" eyebrow="Product" title="See Relay *in action*" lead="Everything your team needs to plan, publish, reply and learn — in one place." />
        <ul className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {DEMOS.map((d) => (
            <Reveal as="li" key={d.id}>
              <article id={d.anchor} aria-labelledby={`${d.id}-title`} className="grid h-full scroll-mt-24 grid-cols-1 gap-6 overflow-hidden rounded-[24px] border border-v5-border bg-[var(--mkt-lavender)]/40 p-5 sm:p-7 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" data-testid={`mkt-demo-${d.id}`}>
                <div className="flex flex-col items-start gap-3">
                  <IconTile className="bg-v5-surface">{d.icon}</IconTile>
                  <h3 id={`${d.id}-title`} tabIndex={-1} className="text-[22px] font-bold leading-tight tracking-[-0.02em] text-v5-fg outline-none">{d.title}</h3>
                  <p className="text-[15px] text-v5-muted">{d.text}</p>
                  <p className="text-[13px] font-medium text-v5-fg">{d.plan}</p>
                  <div className="mt-auto pt-2">
                    <ExploreDialog label={d.explore} title={d.title} description={d.text} testId={`mkt-explore-${d.id}`}>
                      <div className="flex flex-col gap-4">
                        <ul className="flex flex-col gap-2 text-[15px]">
                          {d.includes.map((i) => <li key={i} className="flex gap-2"><span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-v5-primary-text" /><span>{i}</span></li>)}
                        </ul>
                        <p className="rounded-xl bg-v5-raised p-3 text-[14px] text-v5-muted"><Badge variant="warn" className="mr-2 align-[1px]">Note</Badge>{d.access}</p>
                        <div className="flex flex-wrap items-center gap-3">
                          <ButtonLink href={`/signup`}>Start free trial</ButtonLink>
                          <span className="text-[13px] text-v5-muted">{TRIAL_DAYS} days free · {d.plan}</span>
                        </div>
                      </div>
                    </ExploreDialog>
                  </div>
                </div>
                <div className="min-h-[340px] min-w-0">{d.preview}</div>
              </article>
            </Reveal>
          ))}
        </ul>
      </Container>
    </section>
  );
}
