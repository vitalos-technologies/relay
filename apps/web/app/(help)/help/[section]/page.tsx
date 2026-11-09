// Help Centre section (HC): the section's articles this reader may open.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { helpLibrary } from '@social-lite/services/help/library';
import { helpSection, isHelpSection } from '@social-lite/services/help/schema';
import { Breadcrumbs, HelpFrame } from '@/components/help/help-frame';
import { SignInLink } from '@/components/help/sign-in-link';
import { getHelpViewer } from '@/lib/help-server';
import { frameSections } from '@/lib/help-view';

type Params = { params: Promise<{ section: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { section } = await params;
  return { title: helpSection(section)?.title ?? 'Help Centre' };
}

export default async function HelpSectionPage({ params }: Params) {
  const { section } = await params;
  if (!isHelpSection(section)) notFound();
  const meta = helpSection(section)!;
  const viewer = await getHelpViewer();
  const sections = frameSections(viewer.audiences);
  const articles = sections.find((s) => s.id === section)?.articles ?? [];
  const lib = helpLibrary();
  const summaries = new Map(lib.articles.map((a) => [a.slug, a.summary]));
  const restricted = lib.articles.filter((a) => a.section === section).length - articles.length;

  return (
    <HelpFrame sections={sections} section={section}>
      <Breadcrumbs items={[{ label: 'Help', href: '/help' }, { label: meta.title }]} />
      <h1 className="text-[24px] font-semibold tracking-[-0.01em] sm:text-[26px]">{meta.title}</h1>
      <p className="mt-1 max-w-[640px] text-[15px] text-muted">{meta.description}</p>
      {articles.length ? (
        <ul className="mt-6 flex max-w-[760px] flex-col gap-2">
          {articles.map((a) => (
            <li key={a.slug}>
              <Link href={a.href} className="block rounded-xl border border-border bg-surface px-4 py-3 hover:border-border-strong">
                <span className="block text-[15px] font-semibold text-fg">{a.title}</span>
                <span className="mt-0.5 block text-[13.5px] text-muted">{summaries.get(a.slug)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-6 text-[14px] text-muted">No articles here yet.</p>
      )}
      {restricted > 0 && !viewer.signedIn ? (
        <div className="mt-6 flex max-w-[760px] flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[14px] text-muted">More articles in this section are available after you sign in.</p>
          <SignInLink variant="primary" />
        </div>
      ) : null}
    </HelpFrame>
  );
}
