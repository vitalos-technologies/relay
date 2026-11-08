# V5 marketing mockup — visual notes

The user shared the mockup in chat on 2026-11-08; the image file did not reach the repository. These notes transcribe it so
V5 can be built in any session. If the image is added later, save it as `docs/brand/v5-marketing-mockup.png`.

The mockup is branded "SocialFlow" with invented stats, testimonials, customer logos and three price tiers. **Use only its
visual direction.** Brand = Relay; content, pricing and claims follow `docs/queue/03h_V5_PROMPT.md`.

## Overall look
- White page, very dark navy/ink headings (heavy weight, tight tracking), grey body text.
- Primary action: deep indigo/purple filled pill buttons (≈ `#2E1A6B`–`#3B1F8F`), white text, small → arrow.
- Secondary action: white outline pill with dark text (e.g. "▶ Watch demo").
- Accent gradient on one keyword per heading: purple → magenta/pink ("social media", "manage social media",
  "in action", "marketing teams", "pricing", "media?").
- Soft lavender/pink blurred blobs at the edges of the hero and final CTA band only; no animated backgrounds.
- Rounded cards (≈ 16–20 px radius), hairline borders, very soft shadows; icon tiles = small rounded lavender squares with
  a purple line icon.
- Generous whitespace; desktop content width ≈ 1100–1200 px.

## Sections, top to bottom (mockup → what Relay does)
1. **Header**: logo left; centre nav (Product ▾, Solutions ▾, Resources ▾, Pricing); right "Log in" text link + filled
   "Start free trial". → Relay: section anchors Product · AI · Integrations · Pricing · FAQ (no dropdowns); Log in;
   Start free trial; Open dashboard when signed in; mobile menu.
2. **Hero**: two columns. Left: two-line headline, large (≈ 56–64 px), gradient keyword; buttons "Start free trial →" +
   "▶ Watch demo". Right: tilted-free product visual — a dark navy vertical icon rail + white "Content" planner card
   (tabs Schedule / Drafts / Published; weekday row Mon 20 … Fri 24 with the active day as a purple pill; three image
   thumbnails with small network badges), a floating "Engagement ↑ +32%" sparkline card top-right, a floating "Scheduled ·
   Wed, Jan 22 · 10:00 AM" toast with a green check bottom-right, and floating network app icons (Instagram, TikTok,
   YouTube, LinkedIn, X) above. Lavender blob behind. → Relay: same composition with synthetic content; any metric shown
   must be visibly labelled as an example, or use non-metric content (a scheduled toast, an inbox reply, an AI task result).
3. **Capability strip**: four centred items with icon tile + label (Plan, Create, Analyze, Collaborate), thin vertical
   dividers. → Relay: Plan · Engage · Understand · Collaborate.
4. **"Trusted by growing brands"** logo row (Spotify, Canva, Notion, HubSpot, Shopify, Dropbox). → **Do not build.**
   Relay replaces it with "Connect your tools" (implemented integrations, honest status) further down.
5. **"Everything you need to …"**: four small feature cards in a row (icon tile, bold title, two-line description).
6. **"See … in action"**: 2×2 grid of wide cards; each = left text (icon tile, title, one sentence, "Explore … →" purple
   link) + right mini product UI that overflows slightly over a lavender blob:
   - Scheduling: "New post" composer (image, network icons row, date chip "Wed, Jan 22", time chip "10:00 AM", purple
     "Schedule" button).
   - Inbox: tabs All / Comments / Messages / Mentions (All = purple pill); two message rows with avatar, network badge,
     handle, snippet, relative time, unread dot.
   - Analytics: "Last 28 days ▾", three KPIs (Engagement, Reach, Followers with green deltas), purple area line chart.
   - AI Assistant: "Ask AI Assistant" panel, prompt "Generate 3 caption ideas for a product launch" with purple send
     button, chips Captions · Ideas · Repurpose.
   → Relay: these four cards become the product demonstrations (§4); Explore links scroll/open inline previews.
7. **Stats band** (500K+ users, 10M+ posts, +42%, 4.8/5) on a lavender rounded band. → **Do not build** (fabricated).
8. **"Loved by marketing teams"** three testimonial cards. → **Do not build** (fabricated).
9. **Pricing**: "Simple, flexible pricing" + subline; three cards (Starter $19, Pro $49 "Most popular" with purple border
   and badge + filled button, Business $99), each with icon, name, one-line audience, price "/mo", "Billed monthly",
   4 check items, button. → Relay: **two** cards only — Standard £10 and Professional £25 per user / month, "14 days free";
   Professional may carry the highlighted treatment; expandable comparison below.
10. **Final CTA band**: rounded lavender → pink gradient band with blobs, headline with gradient word, one-line subline,
    filled "Start free trial →". → Relay: keep; no "join thousands" claim.
11. **Footer**: logo + one-line description; four link columns (Product, Solutions, Resources, Company); social icons.
    → Relay: minimal — logo, section anchors, Log in / Start free trial, Support, Privacy, Terms.

## Colour reading (approximate, from the image)
| Role | Approx. |
|---|---|
| Ink headings | `#0F0F2D` |
| Body grey | `#5B5F73` |
| Primary button | `#2E1A6B` (hover a touch lighter) |
| Accent gradient | `#7C3AED` → `#D946EF` |
| Lavender surface / blobs | `#EFE9FF` / `#E9D5FF` → `#FBCFE8` |
| Card border | `#ECEAF3` |
| Positive delta | `#16A34A` |

Relay's own brand kit is orange/red/amber (`docs/DECISIONS.md` D18–D19). The user asked V5 to follow this mockup's purple
direction for the marketing page; record the decision (marketing palette vs. app palette, logo usage) in
`docs/DECISIONS.md` when V5 starts, and keep the app's existing tokens unless the user decides otherwise.
