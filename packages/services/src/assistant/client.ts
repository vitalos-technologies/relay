// Assistant model client. The real client calls the configured provider through the official SDK with a structured
// output schema; the model gets no tools, no credentials and no network access of its own. Tests inject a
// deterministic fake with setAssistantModelClient (never available in the running app: when no provider key is
// configured the assistant reports "not configured" and stays off — no fixture outputs).
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { AppError } from '@social-lite/core';
import { PROPOSED_ACTION_KINDS } from '@social-lite/core/contracts/v35-ai';
import { getSetting, settingSource } from '../settings.js';
import { AI_SETUP_HINT, configuredModel, usesServerFallback } from '../ai/models.js';
import type { Queryable } from '@social-lite/db';

export const assistantOutputSchema = z.object({
  summary: z.string(),
  evidence: z.array(z.object({ source: z.string(), quote: z.string() })),
  suggestions: z.array(z.object({
    kind: z.enum(['reply', 'copy', 'summary', 'translation', 'brief', 'answer', 'labels', 'explanation']),
    text: z.string(),
    language: z.string(),
    based_on: z.array(z.string()),
  })),
  proposed: z.array(z.object({ kind: z.enum(PROPOSED_ACTION_KINDS), value: z.string() })),
  answerable: z.boolean(),
  uncertainty: z.string(),
});
export type AssistantModelOutput = z.infer<typeof assistantOutputSchema>;

export interface AssistantCallRequest { model: string; maxTokens: number; system: string; prompt: string }
export interface AssistantCallResult { output: AssistantModelOutput | null; stopReason: string | null; model: string; inputTokens: number; outputTokens: number }

export interface AssistantModelClient {
  readonly provider: string;
  generate(req: AssistantCallRequest): Promise<AssistantCallResult>;
}

export class AnthropicAssistantClient implements AssistantModelClient {
  readonly provider = 'anthropic';
  private readonly sdk: Anthropic;
  constructor(apiKey: string, opts: { timeoutMs?: number; fetch?: typeof fetch; maxRetries?: number } = {}) {
    this.sdk = new Anthropic({ apiKey, authToken: null, timeout: opts.timeoutMs ?? 120_000, maxRetries: opts.maxRetries ?? 2, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }

  async generate(req: AssistantCallRequest): Promise<AssistantCallResult> {
    try {
      const res = await this.sdk.beta.messages.parse({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
        output_config: { effort: 'medium', format: betaZodOutputFormat(assistantOutputSchema) },
        // Server-side refusal fallback only for models listed in AI_FALLBACK_MODELS (deployment setting, D32).
        ...(usesServerFallback(req.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      const u = res.usage;
      const inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      const ok = res.stop_reason !== 'refusal' && res.stop_reason !== 'max_tokens';
      return { output: ok ? res.parsed_output ?? null : null, stopReason: res.stop_reason ?? null, model: res.model, inputTokens, outputTokens: u.output_tokens ?? 0 };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new AppError('provider_not_configured', 'The AI provider rejected the configured key.');
      if (err instanceof Anthropic.RateLimitError) throw new AppError('rate_limited', 'The AI provider is busy. Try again in a minute.');
      if (err instanceof Anthropic.BadRequestError) throw new AppError('provider_error', 'The AI provider could not process this request.');
      if (err instanceof Anthropic.APIError) throw new AppError('provider_error', 'The AI provider is unavailable. Try again shortly.');
      throw err;
    }
  }
}

let override: AssistantModelClient | null = null;
/** Tests only: inject a deterministic fake provider. Pass null to restore normal resolution. */
export function setAssistantModelClient(c: AssistantModelClient | null): void { override = c; }

export const NOT_CONFIGURED_MESSAGE = `AI is not set up. ${AI_SETUP_HINT}`;

/** Provider configured? D32: the provider key (env or protected Setup) AND AI_MODEL. Never returns the key. */
export async function assistantConfigured(db?: Queryable): Promise<boolean> {
  if (!configuredModel()) return false;
  if (override) return true;
  return (await settingSource('ANTHROPIC_API_KEY', db)) !== null;
}

/** Resolve the client, or null when AI is not set up (key or model missing; the run is recorded as not_configured). */
export async function resolveAssistantClient(): Promise<AssistantModelClient | null> {
  if (!configuredModel()) return null;
  if (override) return override;
  const key = await getSetting('ANTHROPIC_API_KEY');
  return key ? new AnthropicAssistantClient(key) : null;
}
