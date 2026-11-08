'use client';
// Usage and limits (V3.1 Admin §14): the real workspace caps and team budgets (enforced in services, workers and MCP by
// atomic reservations). There is no billing system: plans, invoices and payment status are shown as not available.
import dynamic from 'next/dynamic';
import { PageHeader, Skeleton } from '@/components/ui';
import { NotAvailable } from '@/components/admin/ui';

const BudgetsSettings = dynamic(() => import('@/components/integrations/budgets-settings').then((m) => m.BudgetsSettings), { loading: () => <Skeleton className="h-64 w-full rounded-xl" /> });

export default function AdminUsagePage() {
  return (
    <>
      <PageHeader title="Usage and limits" />
      <div className="flex max-w-4xl flex-col gap-6">
        <BudgetsSettings />
        <NotAvailable title="Plans and billing" why="Relay has no billing system yet: no plans, seats pricing, invoices or payment status exist. Caps above are the only limits." />
      </div>
    </>
  );
}
