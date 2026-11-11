// Service glyphs for the integrations section (server-rendered SVG, no JS, no image requests). simple-icons marks where the
// package has them; Slack and monday.com are not in simple-icons, so they get a plain monogram (identification only — no
// logo artwork is reproduced). The section draws every glyph in one grey and shows the brand colour on hover.
import { siAsana, siGoogle, siGoogledrive, siGoogletranslate, siHubspot, siMailchimp, siModelcontextprotocol, siNotion, siWhatsapp } from 'simple-icons';
import type { ToolKey } from './integrations-data';

type Glyph = { path?: string; mono?: string; color: string };
const GLYPHS: Record<ToolKey, Glyph> = {
  slack: { mono: 'S', color: '#4A154B' },
  asana: { path: siAsana.path, color: `#${siAsana.hex}` },
  monday: { mono: 'm', color: '#6161FF' },
  hubspot: { path: siHubspot.path, color: `#${siHubspot.hex}` },
  mailchimp: { path: siMailchimp.path, color: '#241C15' },
  google_business_profile: { path: siGoogle.path, color: `#${siGoogle.hex}` },
  google_translate: { path: siGoogletranslate.path, color: `#${siGoogletranslate.hex}` },
  whatsapp: { path: siWhatsapp.path, color: '#128C4A' },
  google_drive: { path: siGoogledrive.path, color: `#${siGoogledrive.hex}` },
  notion: { path: siNotion.path, color: '#000000' },
  mcp: { path: siModelcontextprotocol.path, color: '#000000' },
};

/** Glyph (path or monogram) and brand colour for a tool. */
export const toolGlyph = (tool: ToolKey): Glyph => GLYPHS[tool];
