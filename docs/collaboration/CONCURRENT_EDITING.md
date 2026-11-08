# Concurrent editing

Relay does **not** do live character-by-character co-editing. Several people can have a post open; saving is safe because
every save is checked against the version it started from. Presence and change notices tell you someone else is there.

## How saving works

- The editor autosaves ~0.8 s after you stop typing (`PUT /api/posts/:id/autosave`) with the version it started from
  (`base_version`) and a per-tab revision. Status: **Saving… → Saved** (only after the server acknowledged), **Unsaved**,
  **Saved locally** / **Offline** (copy kept in this browser, per the workspace policy), **Save failed**, **Edited elsewhere**.
- If the server has moved on, the save is refused (**409**) and nothing is overwritten. Your rejected content is kept on the
  server as an **unsaved copy** in History, and the browser keeps its own copy.
- Identical content never creates a version; an out-of-order save from the same tab is ignored; a retried save whose answer
  was lost returns the original result.

## Seeing other people's changes

- **Presence** (header avatars): who is viewing or editing now; “recently active” up to 5 min. Informational only.
- **“A newer version was saved”** banner: the change stream tells open editors when someone else saves. With no unsaved
  edits you can load the latest; with unsaved edits you review the changes first.
- **After a reconnect** (or when the stream says your cursor is too old) the editor re-checks the server version.

## Resolving a conflict

The dialog compares your version with the latest, field by field (title, text, link, media, destinations, network versions,
publishing options), and labels each **You changed / They changed / Both changed** against the version this tab last saved.

| Choice | What happens |
|---|---|
| **Apply selected to latest** (default: the parts you changed) | your chosen parts are applied on top of the latest version and saved as a normal checked save; unselected parts keep their version. If it changed again meanwhile, the dialog returns. |
| **Keep mine as new draft** | your whole version becomes a separate draft; the post keeps theirs |
| **Copy my text** | copies your title and text to the clipboard |
| **Discard mine…** | explicit, confirmed: drops your unsaved edits in this tab (the server's unsaved copy stays in History) |
| **Later** | close; nothing changes; status stays “Edited elsewhere” |

## History and restore

- History lists versions (author, time, change summary, discussions started on that version) and submitted revisions with
  their review decisions and publication links; it loads 20 at a time and fetches content only to compare.
- Compare any version (or submitted revision, or unsaved copy) with the current draft: text diff, per-network text, media,
  links, destinations, options, schedule.
- **Restore** creates a new version (an ordinary checked save). History is never rewritten, published records are untouched,
  and old approvals never come back — the change resets any pending review, which must be submitted again.

## Recovery after refresh, crash or offline

Unchanged from V3.1 (`docs/V3_1_DATA_API.md`): a browser copy that differs from the server is offered on return; restoring
re-checks permission and version, and a newer server version is never overwritten (the copy is kept in History instead).

## Tests

`tests/integration/collab-complete.test.ts` (simultaneous autosaves → one wins, one conflict copy; compare; restore as new
version; reviews reset after edits), `tests/e2e/collaboration.spec.ts` (conflict dialog → apply selected keeps both
people's changes; history compare + restore), `scripts/collab-mobile-qa.mjs` workflow 8 (conflict on a phone).
