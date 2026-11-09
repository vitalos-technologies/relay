// AI caption assistance (V1.1). Import as '@social-lite/services/ai/index'.
export * from './types.js';
export { aiStatus, suggestForPost, setAiModelClient, aiFixtureEnabled, estimateInputTokens, AI_MAX_OUTPUT_TOKENS, POST_TEXT_MAX_CHARS, NOT_CONFIGURED } from './service.js';
export { checkSuggestion, extractFacts, extractUrls, findProhibited, findPromiseLanguage, type Fact, type FactKind, type LimitTarget } from './fidelity.js';
export { AnthropicModelClient, FixtureModelClient, type AiModelClient, type ModelCallRequest, type ModelCallResult } from './client.js';
export { buildUserPrompt, quote, SYSTEM_PROMPT, modelOutputSchema, type ModelOutput, type PromptInput, type PromptTarget } from './prompt.js';
export { fetchSourceUrl, htmlToText, sanitizeText, SOURCE_MAX_CHARS } from './source.js';
export { AI_METER, DEFAULT_AI_MONTHLY_TOKENS, capFromLimits, readUsage, reserveTokens, settleTokens } from './usage.js';
export { aiModelSetupState, configuredModel, costEstimateForTotals, costEstimateUsd, FIXTURE_MODEL, modelPrice, requireModel, usesServerFallback, type AiModelSetupState } from './models.js';
