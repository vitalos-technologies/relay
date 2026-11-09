---
title: Recover unsaved changes and work offline
summary: How Relay keeps a local copy while you're offline or a save fails, how to restore it, and how admins control browser copies.
section: publishing
audience: user
roles: [owner, admin, brand_manager, editor]
status: available
related: [create-a-post, edit-at-the-same-time, version-history-and-restore]
product_version: "2026-11"
reviewed: 2026-11-09
order: 62
keywords: [offline, unsaved, lost changes, autosave, draft recovery, browser copy]
---

## While you write

- Online, Relay saves shortly after you stop typing.
- Offline, or if a save fails, the status shows **Saved locally** (*Kept in this browser only. Saves when you're back
  online.*) or **Unsaved** (*Not stored anywhere yet. Keep this tab open.*) with **Retry**.
- While offline you can only draft: *You're offline. Drafting only.*

## When you come back

Opening the post again shows one of these banners:

| Banner | Choose |
|---|---|
| Unsaved changes found | **Restore** your local copy into the editor, or **Discard**. |
| Older unsaved copy in this browser | The server has newer content: **Keep as copy** (saves yours as a separate draft) or **Discard**. |
| Unsaved copy can't be synced | You can no longer edit (*You no longer have edit access*, *archived*, *in Trash*, or *no longer exists*). Copy your text, then **Discard**. |

## Workspace setting (admins)

**Settings → Workspace → Draft recovery** ([/settings/workspace/drafts](/settings/workspace/drafts)); changing it needs
`workspace.manage`.

- **Keep unsaved copies**: **This browser** (*Survives a restart*), **This tab only** (*Cleared when the tab closes*) or
  **Off** (*Nothing kept in the browser*).
- **Discard after (hours)**: local copies older than this are deleted.
- **Clear on sign out**: remove local copies when someone signs out.

Choose **This tab only** or **Off** for shared computers.

## Limitations

- A local copy lives in one browser on one device; it doesn't follow you to another device.
