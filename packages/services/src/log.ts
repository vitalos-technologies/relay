// Structured JSON logging with secret redaction. Log IDs and safe categories, not post contents.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const SECRET_KEYS = /token|secret|password|authorization|cookie|code_verifier|client_secret|access_key|refresh|api[_-]?key|signature/i;

/** Redact Telegram token-bearing paths (/bot<token>/) and common query secrets in URLs. */
export function redactUrl(url: string): string {
  return url
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot<redacted>')
    .replace(/([?&](?:access_token|client_secret|code|refresh_token|input_token|appsecret_proof|fb_exchange_token)=)[^&#]*/gi, '$1<redacted>');
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return redactUrl(value).replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-bot-token>');
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '<redacted>' : redact(v, depth + 1);
    return out;
  }
  return value;
}

const threshold = (): number => LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, svc: process.env.SERVICE_NAME ?? 'social-lite', msg, ...(redact(fields ?? {}) as object) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, f),
};
