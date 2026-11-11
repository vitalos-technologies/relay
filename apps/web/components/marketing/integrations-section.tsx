// Integrations (server; brief §4 Integrations — never "Trusted by"). Implemented networks and tools only.
// Layout (user request 2026-11-11, after a reference template, light only): text column (eyebrow, two-tone heading, short
// paragraph that keeps the honesty disclosure, one CTA) beside three staggered rows of icon-only tiles that drift sideways
// (CSS marquee, marketing.css `.mkt-marquee`). Stacks on small screens (text first, full-width rows).
// Accessibility: the moving rows are decorative (`aria-hidden`, each entry drawn three times for a seamless loop); one
// screen-reader list names every network and tool once, with its one-line description and its status in `data-status`
// (integrations-data.ts; tests rely on `mkt-networks`, `mkt-tools`, `mkt-network-*`, `mkt-tool-*`). Glyphs are defined once as
// SVG symbols and reused, so the three copies add little HTML. Reduced motion: the rows are still.
import type { CSSProperties } from 'react';
import type { Provider } from '@social-lite/core';
import { platformGlyphPath } from '@/components/ui/platform-icon';
import { ButtonLink } from '@/components/ui-v5/button';
import { Reveal } from '@/components/ui-v5/reveal';
import { Container, Eyebrow, TwoToneHeading } from './section';
import { TOOLS, networks } from './integrations-data';
import { toolGlyph } from './tool-icon';
import { MarqueeControl } from './marquee-control';

/** Brand colour shown on hover (presentation only). Black marks use the page ink. */
const NETWORK_COLOR: Record<Provider, string> = {
  instagram: '#DD2A7B', facebook: '#0866FF', threads: '#000000', x: '#000000', linkedin: '#0A66C2',
  youtube: '#FF0000', tiktok: '#000000', pinterest: '#BD081C', telegram: '#229ED9', bluesky: '#0285FF',
};

interface Tile { id: string; name: string; color: string; path?: string; mono?: string }
const ROWS = 3;
const COPIES = 3; // one set must be at least as wide as the row; three copies cover every width with a 7-tile set

function Glyph({ t }: { t: Tile }) {
  return t.path
    ? <svg viewBox="0 0 24 24" className="size-9" focusable="false"><use href={`#mkt-glyph-${t.id}`} /></svg>
    : <span className="text-[30px] font-bold leading-none">{t.mono}</span>;
}

export function IntegrationsSection() {
  const nets = networks();
  const tiles: Tile[] = [
    ...nets.map((n) => ({ id: n.provider, name: n.name, color: NETWORK_COLOR[n.provider], path: platformGlyphPath(n.provider) })),
    ...TOOLS.map((t) => ({ id: t.key, name: t.name, ...toolGlyph(t.key) })),
  ];
  // Interleave networks and tools, then deal them into three rows.
  const mixed = Array.from({ length: Math.max(nets.length, TOOLS.length) }, (_, i) => [tiles[i < nets.length ? i : -1], tiles[nets.length + i]])
    .flat().filter((t): t is Tile => !!t);
  const rows = Array.from({ length: ROWS }, (_, r) => mixed.filter((_, i) => i % ROWS === r));
  return (
    <section id="integrations" aria-labelledby="integrations-title" className="scroll-mt-20 py-20 sm:py-24 lg:py-28">
      <svg aria-hidden width="0" height="0" className="absolute" focusable="false">
        <defs>{tiles.filter((t) => t.path).map((t) => <symbol key={t.id} id={`mkt-glyph-${t.id}`} viewBox="0 0 24 24"><path fill="currentColor" d={t.path} /></symbol>)}</defs>
      </svg>
      <Container className="grid items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14">
        <Reveal className="flex flex-col items-start gap-5">
          <Eyebrow>Integrations</Eyebrow>
          <TwoToneHeading id="integrations-title" lines={['Works with the tools', 'you already use.']} />
          <p className="max-w-[30rem] text-pretty text-[16px] leading-[1.5] text-v5-muted sm:text-[17px]" data-testid="mkt-integrations-lead">
            {nets.length} social networks and {TOOLS.length} work apps, built into Relay. Some go live as each network approves Relay’s access.
          </p>
          <ButtonLink href="/signup?plan=free" shape="rounded" className="mt-1 h-11 px-5 text-[15px]" data-testid="mkt-integrations-cta">Get started free</ButtonLink>
          <div className="sr-only">
            <h3>Social networks</h3>
            <ul data-testid="mkt-networks">
              {nets.map((n) => <li key={n.provider} data-testid={`mkt-network-${n.provider}`} data-status={n.status}>{n.name} — {n.does}</li>)}
            </ul>
            <h3>Apps and content sources</h3>
            <ul data-testid="mkt-tools">
              {TOOLS.map((t) => <li key={t.key} data-testid={`mkt-tool-${t.key}`} data-status={t.status}>{t.name} — {t.does}</li>)}
            </ul>
          </div>
        </Reveal>
        <Reveal effect="fade" delay={0.1} className="-mx-4 min-w-0 sm:-mx-6 lg:mx-0">
          <div id="mkt-marquee" aria-hidden className="mkt-marquee flex flex-col gap-2" data-testid="mkt-marquee">
            {rows.map((row, r) => (
              <div key={r} className="mkt-marquee-row">
                <div className="mkt-marquee-track" data-row={r}>
                  {Array.from({ length: COPIES }, (_, c) => (
                    <div key={c} className="mkt-marquee-set">
                      {row.map((t) => (
                        <div key={t.id} className="mkt-int-tile" style={{ '--brand': t.color } as CSSProperties} title={t.name} data-tile={c === 0 ? t.id : undefined}>
                          <Glyph t={t} />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-end px-4 sm:px-6 lg:px-0"><MarqueeControl target="mkt-marquee" /></div>
        </Reveal>
      </Container>
    </section>
  );
}
