# Bluesky provider: AT Protocol (app password session; text + images with rich-text facets)

Code: `packages/providers/src/bluesky/` (`blueskyAdapter`, `blueskyConnector`, `blueskyFake`, `blueskyMetricsFetcher`).
Contract tests: `tests/contracts/v3-bluesky.test.ts` (25 tests).

Research date: **2026-11-07**. Lexicons read from `@atproto/api@0.30.3` (official package, `dist/client/lexicons.js`)
and `bluesky-social/atproto` `lexicons/com/atproto/*`. **Live-test status: not tested.**

## Authentication: app password (clearly labelled option)

atproto OAuth (A6) requires a public HTTPS `client_id` metadata document, **PAR**, **PKCE S256**, **DPoP with
server nonces on every request**, `private_key_jwt` + published JWKS for confidential clients, and bidirectional
handle↔DID↔PDS↔authorization-server resolution. That is not feasible headless in this build (local
`APP_BASE_URL`, no JWKS hosting, DPoP-bound transport), so Social Lite uses **app passwords** — the user creates an
app password in Bluesky Settings → Privacy and security → App passwords and pastes it with their handle. It is stored
encrypted like any credential, can be revoked by the user at any time, and is labelled "App password" in the UI.
atproto OAuth is the documented next step (see Gaps).

## Sources (fetched 2026-11-07)

| # | URL | Used for |
|---|---|---|
| A1 | https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/com/atproto/server/createSession.json | Session create |
| A2 | …/com/atproto/server/refreshSession.json | Refresh (refreshJwt as Bearer), `ExpiredToken`/`InvalidToken` |
| A3 | …/com/atproto/repo/createRecord.json · getRecord.json · uploadBlob.json | Record create (optional `rkey`), read, blob upload |
| A4 | https://www.npmjs.com/package/@atproto/api (0.30.3) `app.bsky.feed.post`, `app.bsky.richtext.facet`, `app.bsky.embed.images`, `app.bsky.feed.getPosts` | Post schema, facets, image embed, counts |
| A5 | https://atproto.com/specs/tid | TID record keys |
| A6 | https://atproto.com/specs/oauth | OAuth requirements (not implemented) |
| A7 | https://docs.bsky.app/docs/advanced-guides/rate-limits (via search results) | Rate limits (assumed figures) |

## Verified facts

- `POST {service}/xrpc/com.atproto.server.createSession {identifier, password}` → `accessJwt, refreshJwt, handle,
  did, didDoc, active, status`; errors `AccountTakedown`, `AuthFactorTokenRequired`.
- `POST /xrpc/com.atproto.server.refreshSession` with `Authorization: Bearer <refreshJwt>` → new pair; errors
  `ExpiredToken`, `InvalidToken`.
- Requests go to the user's **PDS** (`didDoc.service[#atproto_pds].serviceEndpoint`).
- `POST /xrpc/com.atproto.repo.uploadBlob` (raw bytes, `Content-Type` = MIME) → `{blob}`; unreferenced blobs are
  deleted "within a time window (eg, minutes)".
- `POST /xrpc/com.atproto.repo.createRecord {repo, collection:'app.bsky.feed.post', rkey?, record}` → `{uri, cid}`.
  Post record keys are `tid` (13 chars base32-sortable, A5).
- `app.bsky.feed.post`: `text` ≤ **300 graphemes / 3000 bytes**, `createdAt` required, `facets`, `embed`, `langs` ≤ 3.
- Facets: `index {byteStart, byteEnd}` in **UTF-8 bytes** (end exclusive); features `#link {uri}`, `#mention {did}`,
  `#tag {tag ≤ 64 graphemes / 640 bytes, no '#'}`.
- `app.bsky.embed.images`: ≤ **4** images, each blob ≤ **2,000,000 bytes** (formerly 1 MB), `alt` **required**
  (may be empty), optional `aspectRatio {width,height}`.
- `app.bsky.embed.video` exists (mp4 ≤ 300 MB) but the upload service flow was not verified ⇒ **video not supported**.
- `GET /xrpc/app.bsky.feed.getPosts?uris=…` (≤ 25) → `likeCount, repostCount, replyCount, quoteCount,
  bookmarkCount`. No impressions/views exist.

## Assumed

- App passwords have the form `xxxx-xxxx-xxxx-xxxx` (used to warn when a main password is pasted).
- `createRecord` with an existing `rkey` fails (record already exists) instead of creating a second post — combined
  with a deterministic rkey this prevents duplicates; a conflict is reported as **unknown** and reconciled.
- XRPC errors are `{error, message}`; 429 carries `ratelimit-reset` (epoch seconds). Write budget 5,000 points/h,
  35,000/day, create = 3 points (A7, third-party mirror).
- Web URL `https://bsky.app/profile/{handle}/post/{rkey}`.
- Entryway `https://bsky.social`; PDS hosts `*.host.bsky.network` are allow-listed. Self-hosted servers are allowed only
  when the operator lists their exact hostnames in `BLUESKY_SELF_HOSTED_HOSTS` (comma-separated); users cannot add hosts.

## Behaviour

- Text: link appended (if not already present) and annotated with a link facet; `@handle` mentions resolved to DIDs
  via `com.atproto.identity.resolveHandle` (unresolvable handles stay plain text); `#tags` become tag facets.
- `prepare` (nothing visible): refresh/create session as needed, resolve mentions, upload blobs, derive a
  deterministic TID `rkey` and `createdAt`; checkpoint `{rkey, createdAt, facets, blobs[], expiresAt: +5 min}`.
- `publish`: `createRecord` with that `rkey` (`publishes:true`). Lost response/5xx/conflict ⇒ **unknown**;
  `reconcile` = `getRecord(rkey)` → exists ⇒ published; `RecordNotFound` ⇒ **not published** (definitive).
- Alt text: `variant.options.bluesky.altTexts[i]` when set, else the library alt text (`PublishMedia.altText`, fix H3), else an empty string.

## Connection service

`services/connections/bluesky.ts` → `connectBluesky(ctx, brandId, {handle, app_password, service?})` (verify outside any
transaction, encrypted credential, `grantedScopes: ['app_password']`, metadata `auth_method: 'app_password'`). Tested in
`tests/integration/v3-connections.test.ts`. The API route + UI form are not built yet (lead / connections stream).

## Gaps

- atproto OAuth (PAR + DPoP + private_key_jwt) not implemented; app passwords only.
- Video, external link cards (`app.bsky.embed.external` with thumbnail) not implemented.
- Self-hosted PDS: operator allow-list `BLUESKY_SELF_HOSTED_HOSTS`; a non-listed server is refused before any request.
