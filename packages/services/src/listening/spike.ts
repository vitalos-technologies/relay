// Volume-spike decision (pure; brief §15 "minimum sample sizes, baseline logic, deduplication, and cooldowns").
// Baseline = counts of the same-length windows in the previous `baseline_days`, ONLY for windows in which monitoring was
// active (windows before collection began are "not collected", never zeros). A window fires when:
//   observed ≥ min_sample  AND  observed ≥ ceil(mean × multiplier)  AND  observed ≥ ceil(mean + 3σ)  AND  observed > mean
// and there are at least `min_baseline_windows` baseline windows. Dedupe (one alert per rule per window) and cooldown are
// enforced by the caller (unique dedupe key + last-alert check).
import type { SpikeReason } from '@social-lite/core/contracts/v35-listening';
export type { SpikeReason };

export interface SpikeInput { observed: number; baseline: number[]; minSample: number; multiplier: number; minBaselineWindows: number }
export interface SpikeResult { fire: boolean; reason: SpikeReason; mean: number; stddev: number; threshold: number; windows: number }

export function evaluateSpike(i: SpikeInput): SpikeResult {
  const n = i.baseline.length;
  const mean = n ? i.baseline.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? i.baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  const threshold = Math.max(i.minSample, Math.ceil(mean * i.multiplier), Math.ceil(mean + 3 * stddev), Math.floor(mean) + 1);
  const base = { mean: round(mean), stddev: round(stddev), threshold, windows: n };
  if (n < i.minBaselineWindows) return { fire: false, reason: 'insufficient_baseline', ...base };
  if (i.observed < i.minSample) return { fire: false, reason: 'below_minimum_sample', ...base };
  if (i.observed < threshold) return { fire: false, reason: 'within_baseline', ...base };
  return { fire: true, reason: 'fired', ...base };
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Start of the window containing `at` (windows aligned to the epoch, so every evaluator agrees on the dedupe key). */
export function windowStart(at: Date, minutes: number): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

export const SPIKE_REASON_TEXT: Record<SpikeReason, string> = {
  fired: 'Spike detected',
  below_minimum_sample: 'Below the minimum sample',
  insufficient_baseline: 'Not enough monitored history for a baseline yet',
  within_baseline: 'Within the normal range',
  cooldown: 'In cooldown after the last alert',
  already_alerted: 'Already alerted for this window',
  not_collected: 'No source is collecting for this search',
};
