# Relay Admin — user guide

Open **Admin** from the account menu or go to `/admin`. You see only what your role allows; the server checks every
action again.

## Layout
- **Left sidebar** (drawer on phones and tablets): grouped sections — Overview, People and teams, Brands, Publishing,
  Approvals, Content and media, Connections, Analytics, Automations, Developer tools, Security and audit, Operations,
  Settings, Help. Groups open and close; your choice is remembered on this device. *Filter* narrows the list.
- **Scope switch** (Relay staff only): *Workspace* or *Platform*. The breadcrumb always shows the current scope and
  workspace.
- **Jump to** (Ctrl/⌘ K): type a page name and press Enter.
- **Live**: pages refresh within about 10 seconds of changes made anywhere (main app, other admins, workers, MCP).
  *Reconnecting* means the last loaded data is shown while Relay retries; *Paused* means the tab is hidden.

## Common tasks
| Task | Where | What happens | Undo |
|---|---|---|---|
| See what needs attention | Overview | Tiles open the filtered records | – |
| Invite someone / change access | People → Invitations / Members | Invites expire in 72 h. Access changes apply on the person's next action, in every open tab | Revoke the invite or grant |
| Offboard someone | Members → person → Remove | Shows drafts, approvals, schedules, connections and service accounts affected; lets you reassign first | Re-invite |
| Fix a failed post | Publishing → Deliveries → Needs attention → row | Shows what happened and only the actions that are safe now | – |
| Stop publishing quickly | Operations → Pause publishing (workspace) or a brand | Holds posts at send time; posts already sending finish | Resume |
| Check a broken account | Connections → Social accounts → row | Health, expiry, last post, last sync, affected work, the fix; Reconnect | – |
| Review an approval | Approvals → Backlog → item | Same decision flow as the main app | – |
| Revoke an API key or MCP client | Developer tools | Takes effect on the next call | Create a new key |
| Change a setting | Settings group | Saved on the server; shown everywhere | Change it back |
| Find who changed something | Security and audit → Audit log | Filter by area, person, action, date; export (needs export permission) | Audit entries can't be edited |
| Let Relay support look | Security and audit → Support access | Approve a staff request for a fixed time, read-only | End now |

## States you'll see
Healthy · Degraded · Failed · Paused · Unknown · Awaiting setup · Unsupported · Demo. "Demo"/"Simulated" items are
never counted as live results. A dash (—) means "not measured", never zero.
