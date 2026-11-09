---
title: Import from Google Drive and Google Docs
summary: Connect a Google account with per-file access, pick Drive images and videos or Google Docs with Google's picker, choose sections and suggestion handling, and turn them into media, drafts or a campaign.
section: content-sources
audience: user
roles: [owner, admin, brand_manager, editor]
status: needs-setup
related: [content-sources-overview, refresh-imported-content, export-to-google-docs-drive-and-notion, notion]
product_version: "2026-11"
reviewed: 2026-11-09
order: 20
keywords: [google drive, google docs, picker, drive.file, import doc, sections, suggestions, tabs, shared drive]
sources:
  - title: "Google Drive API — choose scopes (drive.file is non-sensitive; restricted Drive scopes need a security assessment)"
    url: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
    verified: 2026-11-09
---

## Before you start

- The workspace owner must have registered Relay with Google (OAuth client and Google Picker) in **Setup**. If not,
  the Google card says **Not set up** or **File picker not set up**.
- Relay asks only for Google's **`drive.file`** permission: access to files you pick or that Relay creates. Google
  classifies it as non-sensitive. Relay cannot see anything else in your Drive.

## Connect Google

1. Open **Settings → Connections → Google Drive and Docs** ([/settings](/settings)), or the **Content sources** section at
   the bottom of **Connections** ([/accounts](/accounts)).
2. Select **Connect**, choose the **Scope** — one brand, or the whole workspace (needs workspace-level connection
   rights) — and sign in to Google.
3. Approve access. If you untick the Drive permission on Google's screen, Relay revokes the half-finished connection
   and tells you; nothing works without it.

The Google connection used for content is separate from YouTube and from signing in to Relay.

## Pick and import Drive images or videos

1. Go to **Library → Sources** ([/library](/library)) for the brand, or use **From Drive or Notion** in the composer.
2. Select **Select** to open Google's picker (it opens with the connected Google account) and choose up to 20 files.
3. Open a file to see the **preview**: account, file name, type and size, target brand, last modified time, whether it
   is in a Shared Drive, and the **Sharing** notice.
4. Optionally tick **Also create a draft with it** and choose **Destination account(s)**.
5. Select **Import copy**.

Relay downloads the file in the background, checks its checksum, and passes it through the same media checks as an
upload (type sniffing, size and decoding limits, derivatives, video processing). Drafts always reference Relay's copy;
a Drive link is never sent to a social network.

| Import can't run when… | Message |
|---|---|
| The owner disabled downloading | "The owner turned off downloading for this file." |
| The image is over 20 MB or the video over 300 MB | "Images must be 20 MB or smaller." / "Videos must be 300 MB or smaller." |
| The file is in the trash | Item shows **Removed** |
| The file changed during download or failed checks | Checksum mismatch / media rejected — select it again |

Shortcuts are followed one step to the real file.

## Pick and import a Google Doc

1. In **Library → Sources**, pick the Doc with **Select**.
2. Open it and review the **Sections**. Relay splits the document at the title and level-1 and level-2 headings,
   across all tabs (child tabs included, in the order Docs shows them).
3. Choose how **Suggested edits** are handled:
   - **Without suggestions** (default) — the text as if suggestions were rejected;
   - **Suggestions accepted** — as if all suggestions were accepted;
   - **Inline** — suggestions shown inline (Relay warns you).
4. Choose the shape: one draft per section, one combined draft, or a **campaign** (enter a **Campaign name**), and
   optionally destination accounts.
5. Select **Import**.

**What is kept:** headings, numbered and bulleted lists (with nesting) and links (as `label (url)`).
**What is flattened or left out, with a visible warning:** images in the document, tables (flattened to
`cell | cell`), tables of contents, equations, footnotes, headers and footers, dropdowns and smart chips. Comments are
never read.

If the Doc changed between the preview and the import, the import stops with **source changed** — preview again so
you import exactly what you reviewed.

## Change notifications (optional)

An Owner or Admin can select **Watch changes** on the Google connection. Google then tells Relay when picked files
change (Relay renews this watch every week, as Google requires). Notifications carry no content: Relay re-reads only
the files you picked and marks them **Changed** or **No access**. Nothing is imported automatically — see
[Refresh imported content](/help/content-sources/refresh-imported-content).

## Repeating an import

Importing the same version with the same options again returns the existing import instead of creating duplicates.
Failed or cancelled imports are re-queued rather than duplicated. (The service supports deliberately requesting a second
copy, but the import dialog does not offer it yet; change the options or refresh the source instead.)

## Disconnect Google

**Settings → Connections → Google Drive and Docs → Disconnect** (Owner/Admin). Relay asks Google to revoke its
access, deletes the stored tokens, stops change notifications and cancels queued imports and exports. Imported media
and drafts stay. See [How imports work](/help/content-sources/content-sources-overview#what-happens-when).

## Limitations

- No folder or whole-Drive sync (that would need a restricted Google scope); pick files individually.
- Google Sheets and Slides are not imported.
- Text in Docs images is not extracted.
