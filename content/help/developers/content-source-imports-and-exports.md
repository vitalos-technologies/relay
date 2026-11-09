---
title: Content source imports and exports
summary: The lifecycle of Google Drive, Google Docs and Notion content in Relay — authorization, selection, preview, import, snapshots, refresh, change signals, writeback, exports and disconnection.
section: developers
audience: developer
status: available
related: [background-jobs-and-media, webhooks, data-model-and-migrations, analytics-ingestion]
product_version: "2026-11"
reviewed: 2026-11-09
order: 65
keywords: [content hub, google drive, google docs, notion, import, export, writeback, snapshot, sources]
---

## Model

Content sources are separate from sign-in and from social destinations: a Google connection for Drive and Docs uses its own OAuth client, tokens and scopes, distinct from the YouTube connection. Code: `packages/services/src/content-hub/`; tables in [Data model and migrations](/help/developers/data-model-and-migrations).

> **Important:** An import is a **copy**. Relay never mirrors the source's sharing permissions: who can see an imported draft is decided by Relay roles and brand grants, not by who can open the original document.

## Lifecycle

| Stage | What happens | Guarantees |
|---|---|---|
| Authorize | OAuth with a single-use hashed state (10-minute expiry) bound to the person, workspace and brand; PKCE verifier stored encrypted. Google asks only for `drive.file` (files the person picks), Notion for read content (plus update/insert only when writeback or exports are used). | Tokens encrypted with the workspace and connection bound into the ciphertext; refresh serialized per connection. |
| Select | The person picks files in the Google Picker or pages in Notion's selection. Relay verifies each selection server-side with the saved authorization and records it per brand (`source_items`). | Only explicitly selected items are visible to Relay, to people in the workspace and to MCP clients (`list_sources`). |
| Preview | The current content is fetched and parsed into sections (title, text, images) with a **fingerprint** and warnings. | Previews are hidden as soon as access to the source is lost. |
| Import | A request with an idempotency key derived from the source identity, its version or fingerprint, the brand, the action and the selection. The worker re-checks the requester's current authority, fetches and validates the content, stores an immutable **snapshot** and creates drafts. Images go through the same validation pipeline as uploads. | Retries never duplicate an import; a person can deliberately ask for another copy. If the source changed since the preview, the import stops with a conflict and asks for a new preview. |
| Refresh (manual) | An authorized re-read. If the content changed, a new snapshot with a diff and a **new draft revision**. | Approved, scheduled or published content is never changed: those posts, and drafts edited in Relay since the import, get a separate new draft instead. Publishing always uses Relay's own copies of media, never source URLs. |
| Change signals (optional) | Google Drive push channels and Notion webhooks mark linked items "change detected". | Signals only: nothing is imported, published or approved automatically. Manual refresh remains the primary path. |
| Writeback (opt-in, Notion) | Relay writes **its own facts** — status, scheduled time, resulting post links — to explicitly mapped Notion properties of imported rows. | One mapped property per update; if someone edited the value in Notion since Relay last saw it, the job stops as a conflict instead of overwriting; Relay's own echoes are ignored; disconnecting, turning writeback off or changing the mapping cancels pending jobs. |
| Export | Report or content exports to Google Docs, Drive or Notion. | Checked when requested and again when the job runs: the destination must be usable by the person for the brand (`exports.create`) and they must still be able to read the content. Always creates a **new** document; never overwrites and never calls sharing endpoints. |
| Disconnect | Relay revokes the token at Google or Notion (best effort), deletes the stored credentials, stops Drive channels and cancels pending jobs. | Imported drafts and posts stay in Relay. Snapshots of items that lost access expire after the workspace retention period unless a **retention hold** is set; deleting a source item is refused while a hold is set. |

## What happens when the source changes or access is revoked

| Event | Effect in Relay |
|---|---|
| The document is edited | Nothing changes automatically. A change signal may mark it "change detected"; a person refreshes to get a new draft revision. |
| The document is deleted or the person loses access | Preview and refresh fail with a clear message; existing drafts, scheduled and published posts are unaffected. |
| The connection is revoked at Google or Notion | The next use fails; the connection shows that it needs reconnecting. Pending imports, writeback and exports stop. |
| The person who connected leaves the workspace | Jobs re-check authority when they run and stop if the person no longer holds it. |

## MCP and API access

MCP clients see only selected items (`list_sources`, `preview_source`, `import_source_to_draft`, `get_import_status`) and never receive Google or Notion credentials. Imports requested over MCP follow the same idempotency and authority rules.

## Related

- [Background jobs and media processing](/help/developers/background-jobs-and-media)
- [Webhooks](/help/developers/webhooks)
