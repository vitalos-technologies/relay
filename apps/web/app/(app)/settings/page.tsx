// /settings → the first sub-setting; legacy /settings?tab=<x> → its new deep link (other query params are kept,
// e.g. Content Hub OAuth returns ?tab=sources&connected=…).
import { redirect } from 'next/navigation';
import { LEGACY_TABS } from '@/components/settings-shell/legacy';

export default async function SettingsIndex({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const tab = typeof sp.tab === 'string' ? sp.tab : null;
  const rest = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === 'tab' || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) rest.append(k, one);
  }
  const target = (tab && LEGACY_TABS[tab]) || '/settings/workspace/general';
  redirect(rest.size ? `${target}?${rest}` : target);
}
