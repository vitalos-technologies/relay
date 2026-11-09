// Contextual help link (HC). Place beside complex settings, metrics, permissions and integration errors:
//   <HelpLink slug="roles-and-permissions" />            → "Help" + icon, opens the article in a new tab
//   <HelpLink slug="time-zones-and-dst" iconOnly label="About time zones" />
// The slug must be a literal string: scripts/docs-check.mjs verifies every slug exists in content/help.
// /help/article/<slug> resolves the article's section on the server (and applies the reader's audience).
import { CircleQuestionMark } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export const helpArticleHref = (slug: string, anchor?: string) => `/help/article/${slug}${anchor ? `#${anchor}` : ''}`;

/** Pass `slug` (literal), or `href` from helpArticleHref('…') when the slug lives in a data table (e.g. the settings
 *  registry) — the docs check scans both forms. */
export function HelpLink({ slug, href, anchor, label, iconOnly, children, className }: {
  slug?: string; href?: string; anchor?: string;
  /** Accessible name (required for iconOnly); defaults to the visible text. */ label?: string;
  iconOnly?: boolean; children?: ReactNode; className?: string;
}) {
  const text = children ?? 'Help';
  return (
    <a
      href={href ?? helpArticleHref(slug ?? '', anchor)}
      target="_blank"
      rel="noopener"
      data-help-slug={slug ?? href?.replace(/^\/help\/article\//, '').replace(/#.*$/, '')}
      aria-label={iconOnly ? `${label ?? 'Help'} (opens in a new tab)` : undefined}
      title={iconOnly ? label ?? 'Help' : undefined}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md text-[13px] font-medium text-accent-text underline-offset-2 hover:underline focus-visible:outline-2',
        iconOnly ? 'touch-target size-7 justify-center text-muted hover:text-fg' : '',
        className,
      )}
    >
      <CircleQuestionMark aria-hidden className="size-4" strokeWidth={1.75} />
      {iconOnly ? null : <>{text}{label ? <span className="sr-only"> — {label}</span> : null}<span className="sr-only"> (opens in a new tab)</span></>}
    </a>
  );
}
