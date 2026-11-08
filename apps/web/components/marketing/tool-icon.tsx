// Service glyph tiles for "Connect your tools" (server-rendered SVG, no JS, no image requests). simple-icons marks where the
// package has them; Slack and monday.com are not in simple-icons, so they get a plain monogram tile in their colour
// (identification only — no logo artwork is reproduced). Decorative: the visible name next to the tile is the label.
import { siAsana, siGoogle, siGoogledrive, siGoogletranslate, siHubspot, siMailchimp, siModelcontextprotocol, siNotion, siWhatsapp } from 'simple-icons';
import type { ToolKey } from './integrations-data';

type Glyph = { path?: string; mono?: string; bg: string; fg?: string; ring?: boolean };
const GLYPHS: Record<ToolKey, Glyph> = {
  slack: { mono: 'S', bg: '#4A154B' },
  asana: { path: siAsana.path, bg: `#${siAsana.hex}` },
  monday: { mono: 'm', bg: '#6161FF' },
  hubspot: { path: siHubspot.path, bg: `#${siHubspot.hex}` },
  mailchimp: { path: siMailchimp.path, bg: `#${siMailchimp.hex}`, fg: '#241C15' },
  google_business_profile: { path: siGoogle.path, bg: `#${siGoogle.hex}` },
  google_translate: { path: siGoogletranslate.path, bg: `#${siGoogletranslate.hex}` },
  whatsapp: { path: siWhatsapp.path, bg: `#${siWhatsapp.hex}`, fg: '#0B3D1F' },
  google_drive: { path: siGoogledrive.path, bg: `#${siGoogledrive.hex}` },
  notion: { path: siNotion.path, bg: '#000000', ring: true },
  mcp: { path: siModelcontextprotocol.path, bg: '#000000', ring: true },
};

export function ToolIcon({ tool, className = 'size-10' }: { tool: ToolKey; className?: string }) {
  const g = GLYPHS[tool];
  return (
    <span aria-hidden className={`inline-flex shrink-0 items-center justify-center rounded-[10px] ${g.ring ? 'ring-1 ring-white/15' : ''} ${className}`} style={{ background: g.bg, color: g.fg ?? '#fff' }}>
      {g.path
        ? <svg viewBox="0 0 24 24" fill="currentColor" className="size-[52%]" focusable="false"><path d={g.path} /></svg>
        : <span className="text-[17px] font-bold leading-none">{g.mono}</span>}
    </span>
  );
}
