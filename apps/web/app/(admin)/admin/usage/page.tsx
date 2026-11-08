'use client';
// Usage and limits (V4 entitlements): plan, allowances (included / used / reserved / limit / warning), held work, what
// stays active under a lowered limit, plan features — then the workspace's own budgets, which can only lower a plan
// allowance. Enforcement lives in the shared entitlement service (services, workers, MCP); this page reads stored state.
import dynamic from 'next/dynamic';
import { PageHeader, Skeleton } from '@/components/ui';

const WorkspaceUsage = dynamic(() => import('@/components/entitlements/workspace-usage').then((m) => m.WorkspaceUsage), { loading: () => <Skeleton className="h-64 w-full rounded-xl" /> });
const BudgetsSettings = dynamic(() => import('@/components/integrations/budgets-settings').then((m) => m.BudgetsSettings), { loading: () => <Skeleton className="h-64 w-full rounded-xl" /> });

export default function AdminUsagePage() {
  return (
    <>
      <PageHeader title="Usage and limits" />
      <div className="flex max-w-4xl flex-col gap-6">
        <WorkspaceUsage />
        <section aria-labelledby="budgets-h" className="flex flex-col gap-3">
          <h2 id="budgets-h" className="text-sm font-semibold">Your budgets</h2>
          <BudgetsSettings />
        </section>
      </div>
    </>
  );
}
