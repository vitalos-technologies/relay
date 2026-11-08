'use client';
// Workspace feature flags (V3.1 §16): GET /api/feature-flags once per shell load. Safe default: off until known.
// Flags only decide which screens are offered; the server still authorizes and enforces every rule.
import { createContext, useContext, type ReactNode } from 'react';
import type { FeatureFlagsResponse } from '@social-lite/core/contracts/v31-gov';
import { useApi } from './use-api';

interface FlagsValue { enabled: (key: string) => boolean; loaded: boolean; refetch: () => Promise<unknown> }
const Ctx = createContext<FlagsValue>({ enabled: () => false, loaded: false, refetch: async () => undefined });

export function FlagsProvider({ children }: { children: ReactNode }) {
  const { data, refetch } = useApi<FeatureFlagsResponse>('/api/feature-flags');
  const on = new Set((data?.flags ?? []).filter((f) => f.enabled).map((f) => f.key));
  return <Ctx.Provider value={{ enabled: (k) => on.has(k), loaded: !!data, refetch }}>{children}</Ctx.Provider>;
}

export function useFlags(): FlagsValue {
  return useContext(Ctx);
}
export function useFlag(key: string): boolean {
  return useContext(Ctx).enabled(key);
}
