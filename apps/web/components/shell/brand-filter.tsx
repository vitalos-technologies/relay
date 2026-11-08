'use client';
import { ChevronDown, Layers } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { useBrandFilter } from '@/lib/client/hooks';
import { Select } from '@/components/ui';

/** Global brand filter stored in ?brand= so it survives reloads and is shareable. */
export function BrandFilter({ compact }: { compact?: boolean }) {
  const { session } = useSession();
  const [brand, setBrand] = useBrandFilter();
  const valid = !brand || session.brands.some((b) => b.id === brand);
  const current = valid && brand ? session.brands.find((b) => b.id === brand) : null;
  const id = compact ? 'brand-filter-m' : 'brand-filter';
  const options = (
    <>
      <option value="">All brands</option>
      {session.brands.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}{b.publishing_paused ? ' (paused)' : ''}
        </option>
      ))}
    </>
  );
  return (
    <div>
      <label htmlFor={id} className="sr-only">Brand filter</label>
      <Select id={id} value={valid ? brand : ''} onChange={(e) => setBrand(e.target.value)} className={compact ? 'max-w-[220px] max-[430px]:hidden' : undefined}>
        {options}
      </Select>
      {compact ? (
        // Narrow phones: initials + chevron; the native picker (full names) opens on tap. Nothing truncates mid-word.
        <div className="relative hidden h-9 items-center gap-1 rounded-lg border border-border bg-surface pl-1.5 pr-1 max-[430px]:inline-flex">
          <span aria-hidden className="flex size-6 items-center justify-center rounded-md bg-tile text-[10px] font-semibold uppercase text-tile-fg">
            {current ? initials(current.name) : <Layers className="size-3.5" />}
          </span>
          <ChevronDown aria-hidden className="size-4 text-muted" />
          <select
            aria-label={`Brand filter: ${current?.name ?? 'All brands'}`}
            value={valid ? brand : ''}
            onChange={(e) => setBrand(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            {options}
          </select>
        </div>
      ) : null}
    </div>
  );
}

function initials(name: string): string {
  return name.replace(/\(.*?\)/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('') || name.slice(0, 2);
}
