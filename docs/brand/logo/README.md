# Relay logo — master files

Source: the client's brand board (`docs/brand/relay-brand-board-2026-11.webp`, supplied 2026-11-09). The board is a raster
image, so these SVGs are a **vector trace** of it: the mark and wordmark were traced from the board's largest (dark) lockup,
smoothed, and re-coloured with the brand gradient sampled from the board. The tagline is traced from the same lockup. If
the designer's original vector file becomes available, replace these files with it (same names) — the app reads the paths
from `apps/web/components/brand/relay-mark.tsx`, so update that component too.

| File | Use |
|---|---|
| `relay-mark.svg` | The "R" mark, orange→red gradient (`#FF8A1E` → `#F7631C` → `#E8361A`), transparent background |
| `relay-mark-mono.svg` | One-colour mark (`currentColor`) for single-colour print, stamps, watermarks |
| `relay-wordmark.svg` | "Relay" wordmark alone, ink `#121416` |
| `relay-logo-light.svg` / `relay-logo-dark.svg` | Horizontal lockup for light / dark backgrounds (wordmark ink / white) |
| `relay-logo-tagline-light.svg` / `relay-logo-tagline-dark.svg` | Lockup with "Create. Coordinate. Publish." |
| `relay-logo-mono-ink.svg` / `relay-logo-mono-white.svg` | One-colour lockups |
| `relay-app-icon-dark.svg` / `relay-app-icon-light.svg` | 1024 × 1024 app icon tiles (22.5 % corner radius; iOS/Android apply their own mask — use the square-corner export there) |

Spacing between mark and wordmark follows the board. Brand colours (D19): orange `#FD6701`, red `#FE4114`, amber `#FDA602`,
ink `#121416`, mist `#EBEDEE`; font Inter.

In the app: `RelayMark` / `RelayWordmark` (`apps/web/components/brand/relay-mark.tsx`), favicon `apps/web/app/icon.svg`,
Apple touch icon `apps/web/app/apple-icon.png` (180 px, from the dark tile), public copies in `apps/web/public/brand/`.
