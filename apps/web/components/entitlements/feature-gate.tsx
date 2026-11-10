'use client';
// D33: whole areas Free does not include (analytics, inbox). Shows the shared upgrade prompt instead of a page that would
// only render 402 errors. A hint only — the API refuses these areas server-side (entitlements/routes.ts).
import type { ReactNode } from 'react';
import type { Feature } from '@social-lite/core/contracts/v4-plans';
import { UpgradePrompt } from './prompts';
import { useEntitlements } from './use-entitlements';

export function FeatureGate({ feature, children }: { feature: Feature; children: ReactNode }) {
  const { data, check } = useEntitlements();
  if (!data) return null;
  if (!check(feature).ok) return <UpgradePrompt feature={feature} className="mt-2" />;
  return <>{children}</>;
}
