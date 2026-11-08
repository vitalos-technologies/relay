// Telegram: the Bot API offers no per-message view/engagement statistics for channel posts, so native
// metrics are UNSUPPORTED. Delivery confirmation is not a view count (spec §17); the UI shows
// "Unavailable", never 0. Checked 2026-11-07 against https://core.telegram.org/bots/api (Message has no
// view counter; channel statistics are only available to MTProto user clients, not bots).
import type { MetricsFetcher } from '../metrics.js';

export const telegramMetricsFetcher: MetricsFetcher = {
  provider: 'telegram',
  billableRead: false,
  metricNames: [],
  fetch: async () => ({ kind: 'unsupported', reason: 'Telegram does not provide post statistics to bots.' }),
};
