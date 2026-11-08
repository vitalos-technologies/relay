# V3 Content integrations — Google Drive & Docs, Notion (Content Hub)

Stream CH. Code: `packages/services/src/content-hub/**`, `packages/services/src/media/ingest.ts`, contracts
`packages/core/src/contracts/{content-hub,exports}.ts`, migration `packages/db/migrations/016_v3_content_hub.sql`,
API `apps/web/app/api/content-hub/**` + `api/webhooks/{google-drive,notion}`, UI `apps/web/components/content-hub/**`
(Library → Sources tab, Settings → Sources tab, Composer “From Drive or Notion”). Tests:
`tests/integration/content-hub.test.ts` (real PostgreSQL + S3, `v2Ctx`, labelled fakes with recorded requests),
`tests/unit/content-hub.test.ts`.

**Nothing in this repository has been run against live Google or Notion.** All provider behaviour is exercised against
labelled test transports (`content-hub/fakes.ts`, mode `test`). Live activation needs real apps (below).

## Sources and scopes

| Source | Connection | Scopes / capabilities | Separate from |
|---|---|---|---|
| Google Drive & Docs | public OAuth web client (`GOOGLE_CONTENT_CLIENT_ID/SECRET`, falls back to the YouTube client) | `openid email https://www.googleapis.com/auth/drive.file` only (non-sensitive, per-file) | sign-in (OIDC) and YouTube: own row in `content_connections`, own token, `include_granted_scopes=false` |
| Google Picker | browser only (`GOOGLE_PICKER_API_KEY`, `GOOGLE_PICKER_APP_ID` = project number) | the browser gets its own short-lived `drive.file` token via Google Identity Services (`login_hint` = connected account); the server token is never sent to the browser | — |
| Notion | public OAuth (`NOTION_CLIENT_ID/SECRET`); `NOTION_INTERNAL_TOKEN` only for an internal **test** installation (refused in production) | read content; update content (writeback) and insert content (exports) only if those features are used | — |

- A connection is **workspace-wide** (`brand_id NULL`, needs workspace-scope `connections.manage`) or **brand-scoped**.
  Using it for a brand always needs the acting person’s permission on that brand.
- No whole-Drive access is requested. A picked folder (export destination) does not grant recursive access to its
  descendants. Folder sync would need `drive.readonly` (restricted scope, security assessment) — **not implemented**;
  manual selection is the supported path.
- Granular consent: if the user declines `drive.file`, the authorization is revoked and refused (`scope_denied`).
- OAuth follows the existing pattern: `oauth_states` row (purpose `connect`, provider `content:google|content:notion`),
  sha256(state) only, single use, 10-minute expiry, consumed only by the session user who started it, PKCE verifier
  encrypted. Content connections need no destination-selection step, so `connection_flows` is not used.
- Tokens are envelope-encrypted with AAD `content-connection:<workspace>:<connection>`; never returned by any API;
  refresh is serialized per connection (advisory lock + `refresh_version` CAS).

## Selection, snapshots and linked sources

Flow: **authorize → select → preview → fetch/validate (worker) → immutable snapshot → draft(s) → normal review/schedule.**

- **Selection** (`POST /api/content-hub/selection`): every id is verified with the saved authorization before it is
  recorded (`source_grants` + per-brand `source_items`). With `drive.file`, Google itself refuses files the user did
  not pick; arbitrary ids, malformed ids, trashed files and ids of another account/tenant are rejected.
- **Snapshot** (`source_snapshots`): app-owned, immutable (UPDATE trigger), with fingerprint (sha256 of normalized
  content or bytes), source checksum (Drive `md5Checksum`), source version (Drive `version` / Notion
  `last_edited_time`), modified time, importer, import time, warnings and an `incomplete` flag. A retry with an
  unchanged fingerprint reuses the snapshot.
- **Linked source** (`source_items`): metadata + a cached preview for the brand. Previews and source links are shown
  **only while the item is readable now** (state `linked`); `access_lost`, `removed` and `disconnected` clear them.
- **ACL boundary**: an import is a private copy visible to people with access to the *target brand in Relay*. Relay
  does **not** mirror or follow Google/Notion sharing, and never changes it. The preview states this before import.
- Imported text is **untrusted data**: stored as plain draft text, never interpreted as instructions; imports never
  submit, approve or schedule anything (no AI needed; direct text import).

### Drive media
Picker ids only → preview (account, filename, MIME/size, target brand, modified time, Shared Drive, sharing effect) →
worker: `files.get` (`supportsAllDrives=true`), one-hop shortcut resolution, `canDownload` check, bounded
`alt=media` download (images ≤ 20 MB, videos ≤ 300 MB), md5 verification, then **the media pipeline**
(`ingestServerBytes` → `completeUpload`: sniffing, polyglot checks, decode limits, derivatives; videos to the video
worker). Drafts reference the app asset id; a Drive URL is never passed to a social provider. Explicit outcomes:
`download_denied`, `removed` (trashed), `checksum_mismatch`, `media_rejected`, too large, not shared.

### Google Docs
`documents.get?includeTabsContent=true&suggestionsViewMode=…` (comments are never requested). Tabs are flattened in UI
order (child tabs included); sections split at Title/H1/H2 (ids `<tabId>:<headingId>`). Headings, ordered/unordered
lists with nesting, and links (`label (url)`) are preserved. Visible warnings: inline/positioned images, tables
(flattened to `cell | cell`), tables of contents, equations, footnotes, headers/footers, dropdowns, smart chips.
Suggestions mode is explicit: `exclude` (default, `PREVIEW_WITHOUT_SUGGESTIONS`), `accept`
(`PREVIEW_SUGGESTIONS_ACCEPTED`), `inline` (`SUGGESTIONS_INLINE`, warned). The user picks sections, the shape
(draft per section / one draft / campaign) and optional destinations. The import must match the previewed
fingerprint; if the document changed, it fails with `source_changed` (preview again).

### Notion pages
Pinned `Notion-Version: 2026-03-11`. Blocks are fetched one level per call (`GET /v1/blocks/{id}/children`,
`page_size=100`, cursor pagination), recursively with bounds (depth 4, 2,000 blocks, 40 list calls); `child_page` /
`child_database` are not followed. Unsupported blocks (`type: unsupported` → `unsupported.block_type`) and limit hits
are disclosed; the snapshot is flagged `incomplete`. Notion-hosted files (`type: file`, URLs valid ~1 h) found in the
selected sections are downloaded **inside the import job** through the SSRF-safe fetcher (no Notion token sent) and
validated into the media library; expired/unavailable files make the import `partial` with a warning. External file
URLs are not fetched. File URLs are never stored.

### Notion data sources
A database contains data sources (API 2025-09-03+); Relay works with **data sources** (`GET /v1/data_sources/{id}`,
`POST /v1/data_sources/{id}/query`, ≤ 10,000 results, `request_status`). Mapping (`import_mappings`) stores property
**ids** for title, body (`page_content` or a rich-text property), campaign (find-or-create by name), target date
(→ post `due_at`), status and external reference, plus opted-in statuses. Mappings are validated against the live
schema (unknown property, wrong type, statuses that don’t exist ⇒ field errors). Row import: only rows whose parent
is this data source; row-level results (`imported | skipped | duplicate | error`), one transaction per row; a row
already imported is reported as `duplicate` (unchanged) or `skipped` (changed — use Refresh). **Notion statuses such
as “Ready”/“Approved” never grant Relay approval** — every row becomes a plain draft.

## Idempotency
`imports.idempotency_key = sha256(connection, kind, source identity, version/fingerprint, selection, options, brand,
action, copy_nonce)` (unique per workspace). Retries return the same import (`deduplicated: true`); failed/cancelled
imports are re-queued, never duplicated; a person can intentionally request another copy (`copy_nonce`).
Exports use the same pattern (`export_jobs.idempotency_key`).

## Refresh and diff
Manual refresh (`POST /api/content-hub/items/:id/refresh`) is the required path and runs in the worker: authorized
re-read → unchanged ⇒ nothing changes; changed ⇒ new snapshot with a diff (sections added/removed/changed + line
diff) and, for each linked draft (`source_post_links`):
- editable draft not edited in Relay since import ⇒ **new draft revision** (version + `post_versions` row);
- draft with an active/pending schedule or published delivery, or edited in Relay ⇒ a **new draft** beside it
  (`new_draft`, reason `approved_or_scheduled` / `edited_in_relay`). Approved/scheduled revisions (`post_revisions`,
  `variants`) are immutable and are never touched. Dispatch always uses app assets.

## Revocation, access loss, retention
- **Disconnect**: best-effort revoke at the provider (Google `oauth2.googleapis.com/revoke`, Notion `/v1/oauth/revoke`),
  stop watch channels, delete stored tokens, cancel queued imports/exports/writebacks, mark items `disconnected` and
  clear previews.
- **Access loss** (401 after one forced refresh / `invalid_grant`): connection `reconnect_required`; background reads
  and writes stop; previews hidden. Item-level 404/403 ⇒ item `access_lost` (trash ⇒ `removed`).
- **Snapshots** already imported stay under the workspace retention policy (`content_hub_settings.snapshot_retention_days`,
  default 365 after access loss/disconnect; worker sweep). Per-item **hold** blocks expiry and deletion; **delete**
  removes the link and snapshots (drafts/assets created from it are app content and stay).

## Writeback (Notion, opt-in)
Enabled per connection (`writeback_enabled`) by someone who manages connections, then per field in the mapping:
Relay status (`Draft in Relay | In review | Scheduled | Published | Failed`), scheduled time, post URLs.
- **Field-scoped**: each PATCH `/v1/pages/{id}` sends exactly one property; properties used for imported content
  (title/body/campaign/date/external ref) cannot be writeback targets.
- **Conflict detection**: before writing, the current value’s fingerprint is compared with what Relay last saw/wrote;
  an external edit ⇒ `conflict` (review: overwrite or keep Notion’s value), never a silent overwrite.
- **Loop prevention**: writeback is driven only by Relay facts (sweep), never by imports, refresh or webhooks; each job
  records `origin_run_id`, `last_seen_fingerprint`, `written_fingerprint`; Notion events authored only by the
  connection’s own bot are ignored; Relay statuses can’t be import statuses on the same property.
- Re-checked at run time: connection active + writeback on, mapping unchanged, the configuring person still manages
  connections for the brand.

## Exports (`ReportExporter`, `packages/core/src/contracts/exports.ts`)
`requestExport(ctx, { destination, title, format, html|text|contentBytes, content })` → `ExportJob`; worker creates:
a **new Google Doc** (HTML upload with conversion, `mimeType=application/vnd.google-apps.document`), a **new file**
in a selected Drive folder (multipart ≤ 5 MB), or a **new Notion page** under a selected parent page. Destination
(`exports.create` + connection + explicitly selected, verified destination grant) and content (`analytics.read` /
`content.read` on the brand) are checked **independently**, at request time and again when the job runs. Sharing
inheritance is reported (`sharing_warning`); Relay never calls permissions/sharing endpoints. Content plans:
`POST /api/content-hub/exports/content-plan`.

## Change notifications (optional; signals only)
- **Drive** `changes.watch` (≤ 1 week, renewed a day before expiry — Drive has no auto-renewal): channel id + random
  token (hash stored), resource id checked; deduplicated by `X-Goog-Message-Number`; notifications have no body and
  only trigger a bounded `changes.list` with the saved authorization, which marks items “changed” or “no access”.
- **Notion** webhooks: `X-Notion-Signature = sha256=HMAC(verification_token, raw body)`, constant-time compare;
  deduplicated by event id (delivery is at-most-once, up to 8 attempts); events only mark items changed / removed.
  The one-time verification handshake is stored encrypted; an owner adopts it (`POST /api/content-hub/settings`) and
  pastes it into Notion. Unverified/unconfigured ⇒ 401. Nothing is imported, approved or published from a signal.

## Jobs
Outbox events `source.import_requested`, `source.changes_signal`, `export.requested`, `writeback.requested` →
queues `source-import`, `report-export`, `writeback` (`engine/outbox-dispatcher.ts` `WORKLOAD_QUEUES`; publishing
keeps `delivery-due`). Handlers (`content-hub/jobs.ts`) reload rows by id, rebuild the requester’s **current**
authority (`jobCtx`; removed/narrowed people fail) and run one job per workspace per class (advisory lock; busy ⇒
retry). Timer `content-hub` (2 min): writeback sweep, channel renewal, snapshot retention.

## Limits
Drive export output 10 MB (Google); multipart export upload 5 MB; Docs JSON 15 MB; Notion depth 4 / 2,000 blocks /
40 calls per page; 100 rows per row import; 50 sections per import; draft text 60,000 chars (truncation warned);
10 media files per Notion import; 20 items per selection.

## Configuration
Setup groups “Google Drive & Docs” and “Notion” (`settings.ts`): `GOOGLE_CONTENT_CLIENT_ID`,
`GOOGLE_CONTENT_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`, `GOOGLE_PICKER_APP_ID`, `NOTION_CLIENT_ID`,
`NOTION_CLIENT_SECRET`, `NOTION_INTERNAL_TOKEN` (non-production), `NOTION_WEBHOOK_VERIFICATION_TOKEN`.
Redirect URIs: `<APP_BASE_URL>/api/content-hub/oauth/{google|notion}/callback`. Webhooks:
`<APP_BASE_URL>/api/webhooks/{google-drive|notion}`. Page CSP allows the Google Picker origins
(`frame-src docs.google.com accounts.google.com content.googleapis.com`; set `CONTENT_HUB_GOOGLE_PICKER=false` to keep
`frame-src 'none'`). Non-production: “Use test data” creates a labelled test connection backed by sample data.

## Verified vs assumed (checked 2026-11-07)

| Fact | Status | Source |
|---|---|---|
| `drive.file` is non-sensitive, per-file; files opened/shared with the app (Picker) | verified | https://developers.google.com/workspace/drive/api/guides/api-specific-auth |
| Picker needs API key, app id = project number (same project as client), OAuth token via `setOAuthToken` | verified | https://developers.google.com/workspace/drive/picker/guides/sample |
| `files.get`: `alt=media` only for blob files, `supportsAllDrives`, Docs need `files.export` | verified | https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get |
| `files.export` output limited to 10 MB | verified | https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export |
| `md5Checksum`/`headRevisionId` binary only; `version` monotonic; `shortcutDetails.targetId`; `driveId`; `capabilities.canDownload` | verified | https://developers.google.com/workspace/drive/api/reference/rest/v3/files |
| Push: `changes.watch` ≤ 1 week, `files.watch` ≤ 1 day, no auto-renewal, empty body, headers, `channels.stop` | verified | https://developers.google.com/workspace/drive/api/guides/push |
| `documents.get` `includeTabsContent`, `suggestionsViewMode`, `commentsViewMode` (needs tabs + inline) | verified | https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get |
| Tabs tree (`childTabs`, `documentTab`) | verified | https://developers.google.com/workspace/docs/api/how-tos/tabs |
| Multipart upload ≤ 5 MB; conversion by Google `mimeType` | verified | https://developers.google.com/workspace/drive/api/guides/manage-uploads |
| Google OAuth web flow, `access_type=offline`, revoke endpoint, granular consent (check `scope`) | verified | https://developers.google.com/identity/protocols/oauth2/web-server |
| Google accepts PKCE (S256) for Web clients but still requires the client secret | **assumed** (third-party reports; Relay sends both) | — |
| `include_granted_scopes=false` keeps the content token separate from YouTube scopes on a shared client | **assumed** | web-server guide (incremental auth) |
| Notion latest version `2026-03-11`; `archived` → `in_trash` | verified | https://developers.notion.com/reference/versioning, https://developers.notion.com/docs/upgrade-guide-2026-03-11 |
| Databases vs data sources; query/retrieve data source; search filter `data_source` | verified | https://developers.notion.com/docs/upgrade-guide-2025-09-03, https://developers.notion.com/reference/query-a-data-source |
| Notion OAuth: Basic auth token exchange, refresh rotates both tokens, `/v1/oauth/revoke` | verified | https://developers.notion.com/docs/authorization, https://developers.notion.com/reference/create-a-token, https://developers.notion.com/reference/revoke-token |
| Notion access-token lifetime | **unknown** (not documented; Relay refreshes after a 401 when a refresh token exists) | — |
| Block children: one level, paginated, `unsupported.block_type` | verified | https://developers.notion.com/reference/get-block-children |
| Notion file URLs valid one hour; re-fetch the object | verified | https://developers.notion.com/reference/file-object |
| PATCH page: omitted properties keep values | verified | https://developers.notion.com/reference/patch-page |
| Rate limits (~3 rps, 429 + Retry-After), request size limits | verified | https://developers.notion.com/reference/request-limits |
| Webhook signature `sha256=` HMAC over raw body with `verification_token`; events are signals; at-most-once, ≤ 8 attempts | verified | https://developers.notion.com/reference/webhooks, https://developers.notion.com/reference/webhooks-events-delivery |
| `page_size` max 100 for block children / queries | **assumed** (long-standing; not stated on the fetched pages) | — |

## Known gaps
- No live verification (needs Google Cloud project with Drive/Docs/Picker APIs + OAuth verification, and a Notion
  public connection). Browser Picker flow is untested end-to-end.
- Notion writeback to `status`-type properties requires the Relay status options to exist in Notion (otherwise the job
  fails with Notion’s validation error).
- Notion webhook handshake adoption trusts the most recent unauthenticated verification POST (the owner confirms by
  pasting it into Notion; a wrong token simply fails verification there).
- Drive folder sync, Sheets/Slides import and AI repurposing of imported content are not implemented.
