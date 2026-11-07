# Working together in Relay

## The collaboration panel

Open any post. On a wide screen the panel sits next to the editor (collapse it with the arrow); on tablets and phones
tap **Collaborate** in the post header to open it full screen. Tabs:

- **Discussion** — comments and replies. The number on the tab is unread discussions.
- **Tasks** — work on this post, plus the post's owner and editorial deadline.
- **Review** — where the review stands, who was asked, and the client sharing list.
- **Activity** — who did what (no comment text).
- **History** — every saved version; compare and restore.

The same discussions and tasks appear on the review page (Approvals → a review).

## Discussions

- Choose **Internal** (your team only) or **Shared with client** (also the clients you shared the review with) before you
  post. A reply always has the same visibility as its discussion.
- Select text in the editor and click **Comment on selection** to attach the quote. If that text is later edited away the
  discussion shows **Outdated**; **From v3** means it was started on an earlier version and the text is still there.
- Type **@** and a name to mention someone. Only people who can see that discussion are suggested. They get one
  notification; editing the comment later only notifies people you newly added.
- **Reply**, **Resolve** / **Reopen**, **Edit** (the old text stays in **Edit history**) and **Delete** (a “Comment deleted”
  placeholder stays).
- **Share with client…** makes an internal discussion visible to clients. You'll be told exactly how many comments will
  become visible. **Make internal…** hides it from clients again.
- Commenting “approved” doesn't approve anything — use Review.

## Tasks

- **New task** (in the panel or on the **Tasks** page): a title, optional details, an assignee, a deadline in a time zone
  you choose, and a priority.
- The deadline is an editorial date. It never changes when the post publishes.
- **Start**, **Mark done**, **Blocked**, **Cancel task**; reassign or move the deadline from the task. **Follow** to hear
  when it's done.
- The **Tasks** page shows *Assigned to me*, *Created by me* and *Team* (with workload per person), filtered by overdue,
  next 7 days, no deadline or needs a new assignee. Each task shows its next step.
- You get one reminder before the deadline and a few (at most) once it's overdue.
- Finishing a task never approves or publishes a post.

## Reviews

- When a brand needs approval, **Submit for review** from the composer. Eligible reviewers are notified.
- In **Review** you can **Request** specific reviewers. Only people the approval policy allows are offered.
- Reviewers open the review, see exactly what will be sent, and **Approve** or **Request changes** (a reason is required;
  the author is notified).
- Editing the post after submitting resets the review (everyone involved is told); submit again.

## Notifications

- The bell shows your latest items; **All notifications** opens the full list with type filters and **Unread only**.
- Each item says who did what and on which post or task, and opens the exact discussion, task or review.
- **Mark read / Mark unread** per item, or **Mark all read**.
- Settings → Personal → Notifications: in app / email / daily digest per type, your time zone and quiet hours.
- Email only says what happened and links back; it never contains comment or post text.

## Presence and editing at the same time

- Avatars in the post header show who else has it open (viewing or editing). It's a hint, not a lock.
- If someone saves while you're editing, Relay tells you. Nothing is ever overwritten silently; see
  `CONCURRENT_EDITING.md` for the choices when both of you changed the post.

## For clients (shared reviews)

Clients see only the reviews shared with them: the exact versions that will be published, shared discussions (never
internal ones), and **Approve** / **Request changes** when the policy allows guests. They can reply in shared discussions
unless the workspace turned client comments off.

## For admins

Admin → **Collaboration**: overdue tasks and review backlog, **Reassign work** (open tasks, reviews and post owners of
people who lost access), **Notification delivery** (email problems and reasons, retry), **Collaboration settings** (client
comments, who can assign tasks, what happens when someone loses access, reminder timing, presence on/off, notification
defaults, eligible reviewers per brand). Every change is in the audit log (filter: Collaboration).
