'use client';
// Who else is on this post. Informational only: it doesn't lock anything and isn't proof that anything was saved.
import { Eye, Pencil } from 'lucide-react';
import type { PresencePerson } from '@/lib/client/collab';
import { InfoTip, Tooltip, cn } from '@/components/ui';

const initials = (n: string) => n.split(/\s+/).map((x) => x[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

export function PresenceBar({ people, className }: { people: PresencePerson[]; className?: string }) {
  if (!people.length) return null;
  const live = people.filter((p) => p.state !== 'recent');
  const editing = live.filter((p) => p.state === 'editing');
  const summary = editing.length
    ? `${editing[0]!.name}${editing.length > 1 ? ` +${editing.length - 1}` : ''} editing`
    : live.length ? `${live[0]!.name}${live.length > 1 ? ` +${live.length - 1}` : ''} viewing` : `${people[0]!.name} was here recently`;
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)} data-testid="presence">
      <ul className="flex -space-x-1.5" aria-label="People on this post">
        {people.slice(0, 4).map((p) => (
          <li key={p.user_id}>
            <Tooltip content={`${p.name} · ${p.state === 'editing' ? 'editing' : p.state === 'viewing' ? 'viewing' : 'recently active'}`}>
              <span tabIndex={0} className={cn('relative inline-flex size-7 items-center justify-center rounded-full border-2 border-surface text-[11px] font-semibold',
                p.state === 'recent' ? 'bg-sunken text-subtle' : 'bg-raised text-fg')}>
                {initials(p.name)}
                {p.state !== 'recent' ? (
                  <span aria-hidden className={cn('absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full border border-surface',
                    p.state === 'editing' ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'bg-success text-surface')}>
                    {p.state === 'editing' ? <Pencil className="size-2" /> : <Eye className="size-2" />}
                  </span>
                ) : null}
                <span className="sr-only">{p.name}, {p.state === 'recent' ? 'recently active' : p.state}</span>
              </span>
            </Tooltip>
          </li>
        ))}
      </ul>
      <span className="hidden truncate text-xs text-muted sm:inline">{summary}</span>
      <InfoTip label="About presence">Who has this post open. It doesn’t lock the post; saving still checks for newer versions.</InfoTip>
    </div>
  );
}
