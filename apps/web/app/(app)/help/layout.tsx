import type { ReactNode } from 'react';
import { HelpShell } from '@/components/support/customer';

export default function HelpLayout({ children }: { children: ReactNode }) {
  return <HelpShell>{children}</HelpShell>;
}
