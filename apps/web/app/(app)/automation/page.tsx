// Automation (V3.5): rules, bounded policies, execution history and the emergency stop.
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AutomationApp } from '@/components/automation/automation-app';
import { UpgradePrompt } from '@/components/entitlements/prompts'; // V4: concise prompt when not in the plan

export const metadata: Metadata = { title: 'Automation' };

export default function AutomationPage() {
  return <><UpgradePrompt feature="automation" className="mb-4" /><Suspense fallback={null}><AutomationApp /></Suspense></>;
}
