// AI model settings (D32). Model ids, the optional fallback list and the optional price table are deployment settings
// (AI_MODEL, AI_FALLBACK_MODELS, AI_MODEL_PRICES; validated at boot in config.ts), never values in code. AI is enabled
// only when the provider key AND AI_MODEL are set. Without a configured price a cost estimate is unknown (null), never
// guessed; budgets are enforced on tokens and do not depend on prices.
import { AppError } from '@social-lite/core';
import { config } from '../config.js';

/** Model label recorded for the deterministic fixture client (development/test only; no model is called). */
export const FIXTURE_MODEL = 'test-fixture';

export const AI_SETUP_HINT = 'An owner can set the provider key and model in Setup.';

/** The configured model id, or null when AI_MODEL is unset. */
export function configuredModel(): string | null {
  return config().AI_MODEL ?? null;
}

/** The configured model id; throws provider_not_configured when unset (callers check configuration first). */
export function requireModel(): string {
  const m = configuredModel();
  if (!m) throw new AppError('provider_not_configured', `AI is not set up. ${AI_SETUP_HINT}`);
  return m;
}

/** Ask the provider for its server-side refusal fallback only for models listed in AI_FALLBACK_MODELS. */
export function usesServerFallback(model: string): boolean {
  return config().AI_FALLBACK_MODELS.includes(model);
}

/** USD per million tokens [input, output], or null when no price is configured for this model. */
export function modelPrice(model: string): [number, number] | null {
  if (model === FIXTURE_MODEL) return [0, 0];
  return config().AI_MODEL_PRICES[model] ?? null;
}

/** Cost estimate in USD, or null when no price is configured for the model (shown as unknown, never guessed). */
export function costEstimateUsd(model: string, input: number, output: number): number | null {
  const p = modelPrice(model);
  if (!p) return null;
  return Math.round(((input * p[0] + output * p[1]) / 1_000_000) * 1e6) / 1e6;
}

/**
 * Estimate for token totals grouped by model (computed at read time from the configured prices). Null when any model
 * that used tokens has no configured price.
 */
export function costEstimateForTotals(rows: Array<{ model: string | null; input_tokens: number; output_tokens: number }>): number | null {
  let total = 0;
  for (const r of rows) {
    const inT = Number(r.input_tokens) || 0;
    const outT = Number(r.output_tokens) || 0;
    if (inT + outT === 0) continue;
    const c = r.model ? costEstimateUsd(r.model, inT, outT) : null;
    if (c === null) return null;
    total += c;
  }
  return Math.round(total * 1e4) / 1e4;
}

export interface AiModelSetupState {
  model: boolean;
  /** A price is configured for the configured model. */
  price: boolean;
  /** Number of models with a configured price (no ids or values). */
  priced_models: number;
  fallback_models: number;
}

/** Which model settings are present — booleans and counts only, never the values. */
export function aiModelSetupState(): AiModelSetupState {
  const c = config();
  return {
    model: !!c.AI_MODEL,
    price: !!c.AI_MODEL && !!c.AI_MODEL_PRICES[c.AI_MODEL],
    priced_models: Object.keys(c.AI_MODEL_PRICES).length,
    fallback_models: c.AI_FALLBACK_MODELS.length,
  };
}
