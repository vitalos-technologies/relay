// Help Centre home (HC): search, section cards, and the ways to reach Relay. `?q=` shows full search results
// (server-rendered, so search works without JavaScript). Everything listed is filtered to what this reader may open.
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowRight, Download, Inbox, MessageSquarePlus } from 'lucide-react';
import { helpLibrary, searchHelp } from '@social-lite/services/help/library';
import { HELP_SECTIONS } from '@social-lite/services/help/schema';
import { HelpSearch } from '@/components/help/help-search';
import { HelpFrame } from '@/components/help/help-frame';
import { sectionIcon } from '@/components/help/help-icons';
import { SignInLink } from '@/components/help/sign-in-link';
import { getHelpViewer } from '@/lib/help-server';
import { frameSections } from '@/lib/help-view';

export const metadata: Metadata = { title: 'Help Centre' };

export default async function HelpHome({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.slice(0, 120) ?? '';
  const viewer = await getHelpViewer();
  const lib = helpLibrary();
  const sections = frameSections(viewer.audiences);
  const results = q.trim() ? searchHelp(lib, viewer.audiences, q, 50) : null;
  const total = sections.reduce((n, s) => n + s.articles.length, 0);
  const hiddenSections = viewer.signedIn ? 0 : HELP_SECTIONS.length - sections.length;

  return (
    <HelpFrame sections={sections}>
      <div className="mb-8 max-w-[720px]">
        <h1 className="text-[24px] font-semibold tracking-[-0.01em] sm:text-[28px]">{results ? 'Search results' : 'How can we help?'}</h1>
        <HelpSearch initialQuery={q} className="mt-4" />
      </div>

      {results ? (
        <section aria-labelledby="results-h">
          <h2 id="results-h" className="mb-3 text-[14px] text-muted">
            {results.length ? `${results.length} article${results.length === 1 ? '' : 's'} for “${q}”` : `No articles match “${q}”`}
          </h2>
          {results.length ? (
            <ol className="flex max-w-[760px] flex-col gap-2">
              {results.map((r) => (
                <li key={r.slug}>
                  <Link href={r.href} className="block rounded-xl border border-border bg-surface px-4 py-3 hover:border-border-strong">
                    <span className="block text-[12px] text-muted">{r.sectionTitle}</span>
                    <span className="mt-0.5 block text-[15px] font-semibold text-fg">{r.title}</span>
                    <span className="mt-1 block text-[13.5px] text-muted">{r.snippet || r.summary}</span>
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <div className="max-w-[640px] rounded-xl border border-border bg-surface p-4 text-[14px] text-muted">
              Try fewer or different words, or browse the sections.
              {!viewer.signedIn ? <> Signed-in members see more articles.</> : null}
            </div>
          )}
          <p className="mt-4"><Link href="/help" className="text-[13px] font-medium text-accent-text hover:underline">Back to Help home</Link></p>
        </section>
      ) : (
        <>
          {!viewer.signedIn && hiddenSections > 0 ? (
            <div className="mb-6 flex max-w-[760px] flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
              <p className="text-[14px] text-muted">Sign in to see every article for your role.</p>
              <SignInLink variant="primary" />
            </div>
          ) : null}
          <section aria-labelledby="sections-h">
            <h2 id="sections-h" className="sr-only">Sections</h2>
            {sections.length ? (
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {sections.map((s) => {
                  const Icon = sectionIcon(s.icon);
                  const meta = HELP_SECTIONS.find((x) => x.id === s.id)!;
                  return (
                    <li key={s.id}>
                      <Link href={`/help/${s.id}`} className="group flex h-full gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-4 transition-colors hover:border-border-strong">
                        <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text"><Icon className="size-[18px]" strokeWidth={1.75} /></span>
                        <span className="min-w-0">
                          <span className="block text-[14.5px] font-semibold text-fg group-hover:underline">{s.title}</span>
                          <span className="mt-0.5 block text-[13px] leading-snug text-muted">{meta.description}</span>
                          <span className="mt-1.5 block text-[12px] text-subtle">{s.articles.length} article{s.articles.length === 1 ? '' : 's'}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[14px] text-muted">No articles yet.</p>
            )}
          </section>

          <section aria-labelledby="more-h" className="mt-10">
            <h2 id="more-h" className="mb-3 text-[15px] font-semibold">More help</h2>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {viewer.signedIn ? (
                <>
                  <MoreCard href="/help/contact" icon={<MessageSquarePlus className="size-[18px]" />} title="Contact support" text="Ask Relay about your workspace, billing or a problem." />
                  <MoreCard href="/help/requests" icon={<Inbox className="size-[18px]" />} title="My requests" text="Follow and reply to your support requests." />
                  <MoreCard href="/api/help/bundle" download icon={<Download className="size-[18px]" />} title="Download offline copy" text={`${total} articles as HTML (zip) for reading offline.`} />
                </>
              ) : (
                <MoreCard href="/login?returnTo=%2Fhelp%2Fcontact" icon={<MessageSquarePlus className="size-[18px]" />} title="Contact support" text="Sign in to send Relay a request and follow it." />
              )}
            </ul>
          </section>
        </>
      )}
    </HelpFrame>
  );
}

function MoreCard({ href, icon, title, text, download }: { href: string; icon: React.ReactNode; title: string; text: string; download?: boolean }) {
  const cls = 'group flex h-full items-start gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-4 hover:border-border-strong';
  const inner = (
    <>
      <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-[14px] font-semibold text-fg group-hover:underline">{title}{download ? null : <ArrowRight aria-hidden className="size-3.5 text-subtle" />}</span>
        <span className="mt-0.5 block text-[13px] leading-snug text-muted">{text}</span>
      </span>
    </>
  );
  return <li>{download ? <a href={href} download className={cls}>{inner}</a> : <Link href={href} className={cls}>{inner}</Link>}</li>;
}
