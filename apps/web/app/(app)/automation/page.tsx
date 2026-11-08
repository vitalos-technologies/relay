// Automation (V3.5): rules, bounded policies, execution history and the emergency stop.
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AutomationApp } from '@/components/automation/automation-app';

export const metadata: Metadata = { title: 'Automation' };

export default function AutomationPage() {
  return <Suspense fallback={null}><AutomationApp /></Suspense>;
}
