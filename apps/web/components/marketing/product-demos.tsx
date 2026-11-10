// Product demonstrations (server shell): four substantial cards — publishing, inbox, analytics + listening, AI (anchor #ai).
// Each: title, one useful sentence, a small interactive preview with example content, an "Explore" inline preview that
// shows a real screenshot of the matching app screen and lists what is included, what still needs provider access, and the
// plan that includes it. On wide, tall viewports the cards form a sticky, scroll-driven stack (StackMotion).
import type { CSSProperties, ReactNode } from 'react';
import { getImageProps } from 'next/image';
import { CalendarClock, ChartLine, Inbox, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui-v5/badge';
import { ButtonLink } from '@/components/ui-v5/button';
import { Reveal } from '@/components/ui-v5/reveal';
import { AiDemo, AnalyticsDemo, ComposerDemo, InboxDemo } from './demos';
import { ExploreDialog } from './explore-dialog';
import { Container, IconTile, SectionHeading } from './section';
import { TRIAL_DAYS } from './plan-data';
import { StackMotion } from './marketing-motion';
import { EXPLORE_ALT } from './explore-shots';

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
    plan: 'Standard and Professional · advanced care on Professional', explore: 'Explore the inbox',
    includes: ['One queue for supported conversation types', 'Assignment, internal notes and reply drafts', 'Reply windows and network rules enforced at send time', 'Service levels and routing on Professional'],
    access: 'Facebook, Instagram, Threads and WhatsApp conversations need Meta approval; X, LinkedIn and TikTok inboxes aren’t available yet.',
    preview: <InboxDemo />,
  },
  {
    id: 'analytics', icon: <ChartLine />, title: 'Analytics and listening', text: 'See what works by channel and post, with data coverage shown — and follow topics on the sources you activate.',
    plan: 'Standard analytics on paid plans · reports and listening on Professional', explore: 'Explore analytics',
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

/** Real screenshots of the matching app screens (synthetic "Relay Showcase" workspace, scripts/marketing-capture.mjs). */
const SHOTS: Record<string, { src: string; alt: string }> = {
  publishing: { src: '/marketing/explore-publishing.webp', alt: EXPLORE_ALT.publishing },
  inbox: { src: '/marketing/explore-inbox.webp', alt: EXPLORE_ALT.inbox },
  analytics: { src: '/marketing/explore-analytics.webp', alt: EXPLORE_ALT.analytics },
  'ai-assistant': { src: '/marketing/explore-assistant.webp', alt: EXPLORE_ALT.assistant },
};

/** Lazy (the modal mounts on first use, and the image is `loading="lazy"`); 2560×1600 reserved so nothing shifts. */
function ExploreShot({ id }: { id: string }) {
  const shot = SHOTS[id]!;
  const { props } = getImageProps({ src: shot.src, alt: shot.alt, width: 2560, height: 1600, quality: 80, loading: 'lazy', sizes: '(min-width: 1080px) 600px, (min-width: 1024px) 56vw, 92vw' });
  return (
    <figure className="flex flex-col gap-2" data-testid={`mkt-explore-shot-${id}`}>
      <div className="overflow-hidden rounded-xl border border-v5-border bg-v5-raised shadow-[var(--mkt-shadow)]">
        <img {...props} alt={shot.alt} className="block aspect-[16/10] h-auto w-full" />
      </div>
      <figcaption className="text-[12px] text-v5-muted">Example workspace</figcaption>
    </figure>
  );
}

export function ProductDemos() {
  return (
    <section id="product" aria-labelledby="product-title" className="scroll-mt-20 overflow-x-clip py-20 sm:py-28">
      <Container className="flex flex-col gap-12">
        <Reveal><SectionHeading id="product-title" eyebrow="Product" title="See Relay *in action*" lead="Everything your team needs to plan, publish, reply and learn — in one place." /></Reveal>
        {/* Wide + tall viewports: a sticky stack (each card slides over the previous one; marketing.css + StackMotion).
            Otherwise, and with reduced motion: a plain list. */}
        <ul className="mkt-stack flex flex-col gap-6 md:gap-10" data-testid="mkt-demos">
          {DEMOS.map((d, i) => (
            <li key={d.id} style={{ '--i': i } as CSSProperties}>
              <Reveal effect={i % 2 ? 'right' : 'left'}>
                <article id={d.anchor} aria-labelledby={`${d.id}-title`} data-stack-card="" className="relative grid scroll-mt-24 grid-cols-1 gap-6 overflow-hidden rounded-[24px] border border-v5-border bg-[color-mix(in_srgb,var(--mkt-lavender)_45%,var(--v5-surface))] p-5 shadow-[var(--mkt-shadow)] sm:p-7 md:min-h-[440px] md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] md:gap-8 lg:p-9" data-testid={`mkt-demo-${d.id}`}>
                  <div className="flex flex-col items-start gap-3">
                    <IconTile className="bg-v5-surface">{d.icon}</IconTile>
                    <h3 id={`${d.id}-title`} tabIndex={-1} className="text-[22px] font-bold leading-tight tracking-[-0.02em] text-v5-fg outline-none sm:text-[26px]">{d.title}</h3>
                    <p className="text-[15px] text-v5-muted sm:text-[16px]">{d.text}</p>
                    <p className="text-[13px] font-medium text-v5-fg">{d.plan}</p>
                    <div className="mt-auto pt-2">
                      <ExploreDialog label={d.explore} title={d.title} description={d.text} testId={`mkt-explore-${d.id}`} media={<ExploreShot id={d.id} />}>
                        <div className="flex flex-col gap-4">
                          <ul className="flex flex-col gap-2 text-[15px]">
                            {d.includes.map((x) => <li key={x} className="flex gap-2"><span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-v5-primary-text" /><span>{x}</span></li>)}
                          </ul>
                          <p className="rounded-xl bg-v5-raised p-3 text-[14px] text-v5-muted"><Badge variant="warn" className="mr-2 align-[1px]">Note</Badge>{d.access}</p>
                          <div className="flex flex-wrap items-center gap-3">
                            <ButtonLink href={`/signup`}>Start free trial</ButtonLink>
                            <span className="text-[13px] text-v5-muted">{TRIAL_DAYS} days free on paid plans</span>
                          </div>
                        </div>
                      </ExploreDialog>
                    </div>
                  </div>
                  <div className="min-h-[340px] min-w-0">{d.preview}</div>
                  <span aria-hidden data-shade="" />
                </article>
              </Reveal>
            </li>
          ))}
        </ul>
        <StackMotion />
      </Container>
    </section>
  );
}
