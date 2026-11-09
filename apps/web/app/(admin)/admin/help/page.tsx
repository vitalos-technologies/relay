// Admin help (V3.1 Admin §20): who can act, what changes, reversibility, delay — one line each. HC: the full guides are
// the Help Centre's admin articles (content/help, audience admin), listed below for readers who may open them.
import Link from 'next/link';
import { helpLibrary, readableArticles } from '@social-lite/services/help/library';
import { helpSection } from '@social-lite/services/help/schema';
import { Card, PageHeader } from '@/components/ui/card';
import { getHelpViewer } from '@/lib/help-server';

export const dynamic = 'force-dynamic';

const TOPICS: Array<{ title: string; href: string; who: string; what: string; undo: string }> = [
  { title: 'Members and roles', href: '/admin/people', who: 'Owners, admins; team managers within their team', what: 'Grants take effect on the next request in every open tab. No one can grant more than they hold.', undo: 'Revoke the grant. Removing a member shows drafts, approvals and schedules affected first.' },
  { title: 'Deliveries', href: '/admin/publishing', who: 'Publishers, brand managers, admins', what: 'Retry, resolve, cancel, reschedule and adopt use the same checks as the composer. Published destinations are never resent.', undo: 'Cancellation can’t recall a post already sending; the result says which.' },
  { title: 'Pausing', href: '/admin/operations', who: 'Approvers and up (resume: publishers and up)', what: 'Holds posts at send time for a workspace, brand or account.', undo: 'Resume queues held posts that are still on time.' },
  { title: 'Approvals', href: '/admin/approvals', who: 'Eligible approvers per policy', what: 'Decisions bind to the exact revision. Edits after approval invalidate it.', undo: 'Reject or cancel the schedule.' },
  { title: 'Social accounts', href: '/admin/connections', who: 'Admins and owners manage; most roles can view', what: 'Reconnect goes to the network. Diagnostics are read-only and never post.', undo: 'Pausing an account is reversible; disconnecting removes stored tokens.' },
  { title: 'Support access', href: '/admin/security/support', who: 'Owners and admins approve', what: 'Relay staff get read-only access for the approved time. Everything they open is attributed to them.', undo: 'End it any time; it also ends on its own.' },
  { title: 'Audit log', href: '/admin/security/audit', who: 'Owners and admins', what: 'Append-only record of changes with actor, scope, result and reference.', undo: 'Entries can’t be edited or deleted by the app.' },
  { title: 'Usage and limits', href: '/admin/usage', who: 'Owners change caps; admins view', what: 'Caps apply to the next reservation in the app, worker and MCP.', undo: 'Remove the cap. Never retroactive.' },
  { title: 'Collaboration', href: '/admin/collaboration', who: 'Everyone sees counts; admins manage settings', what: 'Overdue tasks, review backlog and work held by people who lost access. Discussion text never shows here.', undo: 'Settings are reversible; every change is in the audit log.' },
  { title: 'Reassign work', href: '/admin/collaboration/reassign', who: 'Admins and owners', what: 'Moves open tasks, reviews and post owners to someone who can see each brand. Nothing is approved or published.', undo: 'Reassign again.' },
  { title: 'Notification delivery', href: '/admin/collaboration/notifications', who: 'Admins and owners', what: 'Email outcomes and reasons (no content). In-app notifications work without email.', undo: 'Retry a failed email; access is re-checked first.' },
  { title: 'Live updates', href: '/admin', who: 'Everyone in admin', what: 'Pages refresh within about 10 seconds of a change; “Reconnecting” means showing the last data while retrying.', undo: '—' },
];

export default async function AdminHelpPage() {
  const viewer = await getHelpViewer();
  // Admin articles first (workspace admins and platform staff only), then the administration section's other articles.
  const articles = readableArticles(helpLibrary(), viewer.audiences).filter((a) => a.audience === 'admin' || a.section === 'administration');
  return (
    <>
      <PageHeader title="Admin guide" actions={<Link href="/help" className="text-[13px] font-medium text-accent-text hover:underline">Help Centre</Link>} />
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {TOPICS.map((t) => (
          <Card as="li" key={t.title} className="p-4">
            <Link href={t.href} className="text-[14px] font-semibold hover:underline">{t.title}</Link>
            <dl className="mt-2 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
              <dt className="text-muted">Who</dt><dd>{t.who}</dd>
              <dt className="text-muted">Effect</dt><dd>{t.what}</dd>
              <dt className="text-muted">Undo</dt><dd>{t.undo}</dd>
            </dl>
          </Card>
        ))}
      </ul>
      <section aria-labelledby="admin-articles-h" className="mt-8">
        <h2 id="admin-articles-h" className="mb-3 text-[15px] font-semibold">Admin articles</h2>
        {articles.length ? (
          <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {articles.map((a) => (
              <li key={a.slug}>
                <Link href={a.href} className="block h-full rounded-xl border border-border bg-surface px-4 py-3 hover:border-border-strong">
                  <span className="block text-[12px] text-muted">{helpSection(a.section)?.title}</span>
                  <span className="mt-0.5 block text-[14px] font-semibold">{a.title}</span>
                  <span className="mt-0.5 block text-[13px] text-muted">{a.summary}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">Admin articles are for workspace owners and admins.</p>
        )}
      </section>
    </>
  );
}
