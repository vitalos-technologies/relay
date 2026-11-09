---
title: Edit a post at the same time as someone else
summary: See who else has a post open, and what Relay does when two people save different changes - nothing is ever overwritten silently.
section: publishing
audience: user
roles: [owner, admin, brand_manager, editor]
status: available
related: [version-history-and-restore, recover-unsaved-changes, collaboration-settings]
product_version: "2026-11"
reviewed: 2026-11-09
order: 61
keywords: [conflict, concurrent editing, someone else saved, edited elsewhere, presence, collaboration]
---

## Presence

Avatars in the post header show who else has it open, and whether they're viewing or editing. It's a hint, not a lock;
admins can turn it off.

## When someone else saves first

If another person saved while you had unsaved edits, Relay doesn't save over them. You see **Edited elsewhere** with
**Resolve**, or the dialog **Someone else saved a newer version** — *Nothing was overwritten.*

Your options:

| Option | Effect |
|---|---|
| **Apply selected to latest** | Compare part by part (*Both changed*, *They changed*, *Different in your version*) and choose what to keep from your version. *Unselected parts keep the latest version.* |
| **Keep mine as new draft** | Your version becomes a separate draft. |
| **Later** | Keep editing; resolve before saving. |
| **Discard mine…** | Load the latest version. *Your unsaved changes will be dropped from this tab.* They stay in History as an unsaved copy if the server kept one. |

From a schedule or publish dialog, the shorter **Edited elsewhere** dialog offers **Save mine as copy** or **Load theirs**.
Relay usually keeps your rejected version in **History** as an **Unsaved copy** (*Kept as a copy in History*).

## Good to know

- *Your version matches the latest. Nothing to merge.* means you can simply continue.
- If your access to the post changes while you edit, Relay says *Your access to this post changed — Reload to see what you
  can do now.*
