'use client';
import { useSession } from '@/lib/client/session';
import { useBrandFilter } from '@/lib/client/hooks';
import { Select } from '@/components/ui';

/** Global brand filter stored in ?brand= so it survives reloads and is shareable. */
export function BrandFilter({ compact }: { compact?: boolean }) {
  const { session } = useSession();
  const [brand, setBrand] = useBrandFilter();
  const valid = !brand || session.brands.some((b) => b.id === brand);
  return (
    <div>
      <label htmlFor={compact ? 'brand-filter-m' : 'brand-filter'} className="sr-only">Brand filter</label>
      <Select
        id={compact ? 'brand-filter-m' : 'brand-filter'}
        value={valid ? brand : ''}
        onChange={(e) => setBrand(e.target.value)}
        className={compact ? 'max-w-[220px]' : undefined}
      >
        <option value="">All brands</option>
        {session.brands.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}{b.publishing_paused ? ' (paused)' : ''}
          </option>
        ))}
      </Select>
    </div>
  );
}
