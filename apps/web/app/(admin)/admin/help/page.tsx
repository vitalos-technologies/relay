'use client';
// Admin help (V3.1 Admin §20): who can act, what changes, reversibility, delay — one line each. Full guides in docs/admin/.
import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';

const TOPICS: Array<{ title: string; href: string; who: string; what: string; undo: string }> = [
  { title: 'Members and roles', href: '/admin/people', who: 'Owners, admins; team managers within their team', what: 'Grants take effect on the next request in every open tab. No one can grant more than they hold.', undo: 'Revoke the grant. Removing a member shows drafts, approvals and schedules affected first.' },
  { title: 'Deliveries', href: '/admin/publishing', who: 'Publishers, brand managers, admins', what: 'Retry, resolve, cancel, reschedule and adopt use the same checks as the composer. Published destinations are never resent.', undo: 'Cancellation can’t recall a post already sending; the result says which.' },
  { title: 'Pausing', href: '/admin/operations', who: 'Approvers and up (resume: publishers and up)', what: 'Holds posts at send time for a workspace, brand or account.', undo: 'Resume queues held posts that are still on time.' },
  { title: 'Approvals', href: '/admin/approvals', who: 'Eligible approvers per policy', what: 'Decisions bind to the exact revision. Edits after approval invalidate it.', undo: 'Reject or cancel the schedule.' },
  { title: 'Social accounts', href: '/admin/connections', who: 'Admins and owners manage; most roles can view', what: 'Reconnect goes to the network. Diagnostics are read-only and never post.', undo: 'Pausing an account is reversible; disconnecting removes stored tokens.' },
  { title: 'Support access', href: '/admin/security/support', who: 'Owners and admins approve', what: 'Relay staff get read-only access for the approved time. Everything they open is attributed to them.', undo: 'End it any time; it also ends on its own.' },
  { title: 'Audit log', href: '/admin/security/audit', who: 'Owners and admins', what: 'Append-only record of changes with actor, scope, result and reference.', undo: 'Entries can’t be edited or deleted by the app.' },
  { title: 'Usage and limits', href: '/admin/usage', who: 'Owners change caps; admins view', what: 'Caps apply to the next reservation in the app, worker and MCP.', undo: 'Remove the cap. Never retroactive.' },
  { title: 'Live updates', href: '/admin', who: 'Everyone in admin', what: 'Pages refresh within about 10 seconds of a change; “Reconnecting” means showing the last data while retrying.', undo: '—' },
];

export default function AdminHelpPage() {
  return (
    <>
      <PageHeader title="Admin guide" />
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
      <p className="mt-6 text-xs text-muted">Full guides ship with the installation in docs/admin.</p>
    </>
  );
}
