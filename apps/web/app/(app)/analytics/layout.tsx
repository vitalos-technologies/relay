import type { ReactNode } from 'react';
import { AnalyticsShell } from '@/components/analytics/v3/analytics-shell';

export default function AnalyticsLayout({ children }: { children: ReactNode }) {
  return <AnalyticsShell>{children}</AnalyticsShell>;
}
