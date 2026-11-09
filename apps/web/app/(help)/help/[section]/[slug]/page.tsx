// Help Centre article (HC): sanitised Markdown from content/help, with breadcrumbs, the section sidebar, related
// articles, provider sources, product version and review date. The audience check happens here, on the server:
// signed-out readers get a sign-in prompt for member articles (never their content); signed-in readers without the
// audience get a 404. /help/article/<slug> (HelpLink) and wrong sections redirect to the canonical URL.
import Link from 'next/link';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { ExternalLink, Lock } from 'lucide-react';
import { articleFor, helpLibrary, relatedFor, renderArticle } from '@social-lite/services/help/library';
import { HELP_STATUS_LABEL, helpSection, isHelpSection } from '@social-lite/services/help/schema';
import { Badge } from '@/components/ui/badge';
import { Breadcrumbs, HelpFrame } from '@/components/help/help-frame';
import { SignInLink } from '@/components/help/sign-in-link';
import { getHelpViewer } from '@/lib/help-server';
import { AUDIENCE_LABEL, ROLE_LABEL, fmtHelpDate, frameSections } from '@/lib/help-view';

type Params = { params: Promise<{ section: string; slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const viewer = await getHelpViewer();
  const { article } = articleFor(helpLibrary(), slug, viewer.audiences);
  return article ? { title: article.title, description: article.summary } : { title: 'Help Centre' };
}

export default async function HelpArticlePage({ params }: Params) {
  const { section, slug } = await params;
  const viewer = await getHelpViewer();
  const lib = helpLibrary();
  const { article, hidden } = articleFor(lib, slug, viewer.audiences);

  if (!article) {
    if (hidden && !viewer.signedIn) {
      return (
        <div className="mx-auto max-w-[520px] py-10 text-center">
          <span aria-hidden className="mx-auto inline-flex size-11 items-center justify-center rounded-full bg-raised text-muted"><Lock className="size-5" /></span>
          <h1 className="mt-4 text-[20px] font-semibold">Sign in to read this article</h1>
          <p className="mt-1 text-[14px] text-muted">This article is for Relay members.</p>
          <div className="mt-5 flex justify-center gap-2"><SignInLink variant="primary" /><Link href="/help" className="inline-flex h-9 items-center rounded-lg px-3 text-[13px] font-medium text-muted hover:text-fg">Help home</Link></div>
        </div>
      );
    }
    notFound();
  }
  if (section !== article.section) {
    // HelpLink uses /help/article/<slug>; old links may carry a previous section.
    if (section === 'article') redirect(article.href);
    if (!isHelpSection(section)) notFound();
    permanentRedirect(article.href);
  }

  const sec = helpSection(article.section)!;
  const r = renderArticle(article);
  const related = relatedFor(lib, article, viewer.audiences);
  const status = HELP_STATUS_LABEL[article.status];
  const toc = r.headings.filter((h) => h.level === 2);

  return (
    <HelpFrame sections={frameSections(viewer.audiences)} section={article.section} slug={article.slug}>
      <article className="max-w-[760px]" aria-labelledby="help-title">
        <Breadcrumbs items={[{ label: 'Help', href: '/help' }, { label: sec.title, href: `/help/${sec.id}` }, { label: article.title }]} />
        <h1 id="help-title" className="text-[24px] font-semibold leading-tight tracking-[-0.01em] sm:text-[28px]">{article.title}</h1>
        <p className="mt-2 text-[16px] leading-relaxed text-muted">{article.summary}</p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
          {article.audience !== 'user' && article.audience !== 'public' ? <Badge tone="neutral">{AUDIENCE_LABEL[article.audience]}</Badge> : null}
          {status ? <Badge tone={article.status === 'unsupported' ? 'neutral' : 'warn'}>{status}</Badge> : null}
          {article.roles.length && article.roles.length <= 6 ? <span>Roles: {article.roles.map((x) => ROLE_LABEL[x] ?? x).join(', ')}</span> : null}
        </div>

        {toc.length >= 4 ? (
          <nav aria-label="On this page" className="mt-5 rounded-xl border border-border bg-surface px-4 py-3">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-subtle">On this page</p>
            <ul className="mt-1.5 grid gap-x-6 gap-y-1 text-[13.5px] sm:grid-cols-2">
              {toc.map((h) => <li key={h.id} className="min-w-0"><a href={`#${h.id}`} className="block truncate text-muted hover:text-fg hover:underline">{h.text}</a></li>)}
            </ul>
          </nav>
        ) : null}

        <div className="help-prose mt-6" dangerouslySetInnerHTML={{ __html: r.html }} />

        {article.sources.length ? (
          <section aria-labelledby="sources-h" className="mt-10">
            <h2 id="sources-h" className="text-[15px] font-semibold">Provider sources</h2>
            <ul className="mt-2 flex flex-col gap-1.5 text-[13.5px]">
              {article.sources.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-accent-text hover:underline">
                    {s.title}<ExternalLink aria-hidden className="size-3.5" /><span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  <span className="text-muted"> — last verified {fmtHelpDate(s.verified)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {related.length ? (
          <section aria-labelledby="related-h" className="mt-10">
            <h2 id="related-h" className="text-[15px] font-semibold">Related articles</h2>
            <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {related.map((x) => (
                <li key={x.slug}>
                  <Link href={x.href} className="block h-full rounded-xl border border-border bg-surface px-4 py-3 hover:border-border-strong">
                    <span className="block text-[14px] font-semibold text-fg">{x.title}</span>
                    <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted">{x.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-[12.5px] text-muted">
          <span>Relay {article.product_version} · Reviewed {fmtHelpDate(article.reviewed)}</span>
          {viewer.signedIn ? <Link href="/help/contact" className="font-medium text-accent-text hover:underline">Still stuck? Contact support</Link> : null}
        </footer>
      </article>
    </HelpFrame>
  );
}
