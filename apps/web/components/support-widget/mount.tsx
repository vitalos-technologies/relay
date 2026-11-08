// V5 support widget — the single mount point (server component). The marketing page renders it once with its Platform →
// Marketing config; only the tiny launcher ships in the page bundle, the panel loads after interaction or idle.
import type { MarketingConfig } from '@social-lite/core/contracts/v5-marketing';
import { SupportLauncher } from './launcher';

export function SupportWidgetMount({ config, scopeClass = 'mkt' }: { config: Pick<MarketingConfig, 'widget_enabled' | 'widget_staffed'>; scopeClass?: string }) {
  const staffed = config.widget_enabled && config.widget_staffed;
  return <SupportLauncher enabled={config.widget_enabled} label={staffed ? 'Chat with Relay support' : 'Send us a message'} scopeClass={scopeClass} />;
}
