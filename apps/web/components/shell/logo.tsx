import Link from 'next/link';
import { BRAND } from '@social-lite/core';
import { RelayMark, RelayWordmark } from '@/components/brand/relay-mark';

/** App logo: Relay mark (+ wordmark unless compact). */
export function Logo({ compact }: { compact?: boolean }) {
  return (
    <Link href="/" className="inline-flex items-center rounded-md" aria-label={`${BRAND.name} home`}>
      {compact ? <RelayMark size={24} /> : <RelayWordmark size={24} />}
    </Link>
  );
}
