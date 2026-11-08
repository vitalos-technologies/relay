// Model clients. The real client calls the Claude API through the official SDK with structured
// output; the model gets no tools and no credentials. Tests inject a fake (no network). The fixture
// client (AI_FIXTURE=true, never in production) returns deterministic, clearly labelled suggestions.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AppError, measure } from '@social-lite/core';
import { modelOutputSchema, type ModelOutput, type PromptInput, type PromptTarget } from './prompt.js';

export interface ModelCallRequest {
  model: string;
  maxTokens: number;
  system: string;
  prompt: string;
  /** Structured view of the same request (used by the fixture client; ignored by the real one). */
  input: PromptInput;
}

export interface ModelCallResult {
  output: ModelOutput | null;
  stopReason: string | null;
  /** Model that actually served the request (may differ after a server-side fallback). */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiModelClient {
  readonly fixture: boolean;
  generate(req: ModelCallRequest): Promise<ModelCallResult>;
}

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

export class AnthropicModelClient implements AiModelClient {
  readonly fixture = false;
  private readonly sdk: Anthropic;

  /** `fetch` is injectable so tests can assert the request shape without any network access. */
  constructor(apiKey: string, opts: { timeoutMs?: number; fetch?: typeof fetch; maxRetries?: number } = {}) {
    // Explicit key only; never fall back to ambient credentials on the server.
    this.sdk = new Anthropic({ apiKey, authToken: null, timeout: opts.timeoutMs ?? 120_000, maxRetries: opts.maxRetries ?? 2, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }

  async generate(req: ModelCallRequest): Promise<ModelCallResult> {
    const fallback = FALLBACK_MODELS.has(req.model);
    try {
      const res = await this.sdk.beta.messages.parse({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
        output_config: { effort: 'medium', format: betaZodOutputFormat(modelOutputSchema) },
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      const u = res.usage;
      const inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      const ok = res.stop_reason !== 'refusal' && res.stop_reason !== 'max_tokens';
      return { output: ok ? res.parsed_output ?? null : null, stopReason: res.stop_reason ?? null, model: res.model, inputTokens, outputTokens: u.output_tokens ?? 0 };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new AppError('provider_not_configured', 'The AI provider rejected the configured API key.');
      }
      if (err instanceof Anthropic.RateLimitError) throw new AppError('rate_limited', 'The AI provider is busy. Try again in a minute.');
      if (err instanceof Anthropic.BadRequestError) throw new AppError('provider_error', 'The AI provider could not process this request.');
      if (err instanceof Anthropic.APIError) throw new AppError('provider_error', 'The AI provider is unavailable. Try again shortly.');
      throw err;
    }
  }
}

// ---------------------------------------------------------------- fixture (non-production only)

const FILLER = /\b(really|very|just|actually|basically|simply|truly|quite)\s+/gi;

function tidy(s: string): string {
  return s.replace(FILLER, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Drop whole trailing paragraphs/lines until it fits (fixture only; real limits are still checked). */
function fit(text: string, t: PromptTarget): string {
  const c = t.constraints;
  if (!c) return text;
  const limit = t.hasMedia ? c.maxCaptionLength : c.maxTextLength;
  const lines = text.split('\n');
  while (lines.length > 1 && measure(lines.join('\n'), c.textCounting) > limit) lines.splice(lines.length - 2, 1);
  return lines.join('\n').trim();
}

function fixtureTags(input: PromptInput, text: string): string[] {
  const brand = (input.voice.hashtags ?? []).map((h) => (h.startsWith('#') ? h : `#${h}`));
  const words = [...new Set((text.match(/\b[A-Z][a-z]{3,}\b/g) ?? []).map((w) => `#${w}`))];
  return [...brand, ...words].filter((h) => !text.includes(h)).slice(0, 4);
}

export class FixtureModelClient implements AiModelClient {
  readonly fixture = true;

  async generate(req: ModelCallRequest): Promise<ModelCallResult> {
    const { input } = req;
    const suggestions = input.targets.map((t) => {
      const base = input.task === 'repurpose' ? (input.source?.text.split(/\n{2,}/).slice(0, 2).join('\n\n') ?? t.text) : t.text;
      let text = base;
      let hashtags: string[] = [];
      if (input.task === 'shorten') text = tidy(base);
      if (input.task === 'tone') {
        const extra = [input.voice.default_cta, input.voice.footer].filter((x): x is string => !!x && !base.includes(x));
        text = [tidy(base), ...extra].join('\n\n');
      }
      if (input.task === 'variants') text = fit(tidy(base), t);
      if (input.task === 'hashtags') {
        hashtags = fixtureTags(input, base);
        text = hashtags.length ? `${base.trimEnd()}\n\n${hashtags.join(' ')}` : base;
      }
      if (input.task === 'repurpose') {
        text = tidy(base);
        if (input.source?.url && !text.includes(input.source.url)) text = `${text}\n\n${input.source.url}`;
      }
      return { scope: t.key, text, hashtags, note: 'Test fixture — deterministic suggestion, no model was called.' };
    });
    return { output: { suggestions }, stopReason: 'end_turn', model: 'test-fixture', inputTokens: 0, outputTokens: 0 };
  }
}
