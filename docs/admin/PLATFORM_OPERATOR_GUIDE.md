# Platform operator guide

Platform scope is for Relay staff named in `platform_operators`. Roles: **support** (read-only platform views, support
access requests) and **operator** (plus lifecycle, rollouts, dispatch and operators). Every change needs a fresh,
MFA-verified sign-in (≤ 5 minutes; the app sends you through the identity provider) and a reason, and is written to the
append-only platform audit (and the workspace's own audit when it affects a workspace).

## Bootstrap / break-glass
```
pnpm platform:operator list
pnpm platform:operator grant <email> operator|support   # the person must have signed in once
pnpm platform:operator revoke <email>
```
Run on the server with the application database URL. CLI changes are audited as actor `cli`.

## What you can see
Aggregates and metadata only: workspace names, states, member/brand/account counts, delivery state counts, provider
names, error codes, owners' emails. Never post text, media, documents, tokens or credentials. You have no workspace
permission: the normal policy denies you everywhere.

## Support access
1. Workspaces → open the workspace → *Request support access*: reason, optional ticket, duration (30 min – 24 h).
2. An owner/admin of that workspace approves (they need a fresh sign-in). Unanswered requests lapse after 24 h.
3. While active you are a read-only member (viewer) of that workspace and can switch to it; everything you open is
   attributed to you; the workspace sees a banner.
4. It ends when the time is up, when you end it, when they end it, or when your operator role is revoked.

## Lifecycle and rollouts
- **Suspend workspace**: members lose access on their next request, waiting posts move to Paused at once and any claimed
  later are held by the dispatch gate. Content and memberships are kept. **Reactivate** resumes posts still on time.
- **Dispatch share**: maximum concurrent sends for one workspace (fairness); empty = default.
- **Stop dispatch**: installation-wide; nothing new starts anywhere; sends in progress finish.
- **Rollouts**: default on/off, rollout percentage (stable per workspace), kill switch (beats workspace overrides).
- **Account suspension**: blocks sign-in and ends all sessions. Workspace memberships and scheduled posts are not
  changed — workspaces decide about their members.
