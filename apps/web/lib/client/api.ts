// Typed fetch wrapper for the internal HTTP API (docs/API.md).
//  - same-origin credentials
//  - X-CSRF-Token on mutations (token comes from GET /api/session via SessionProvider)
//  - Idempotency-Key for 🔁 endpoints, stable across retries of the same user action
//  - error envelope -> ApiError { status, code, message, fieldErrors, details, correlationId }
//  - 401 -> redirect to /login?returnTo=<current path>

export type ApiErrorCode =
  | 'unauthenticated' | 'forbidden' | 'csrf_failed' | 'not_found' | 'conflict' | 'version_conflict'
  | 'idempotency_conflict' | 'invalid_state' | 'provider_not_configured' | 'payload_too_large'
  | 'unsupported_media' | 'validation_failed' | 'rate_limited' | 'budget_exhausted' | 'provider_error'
  | 'dispatch_disabled' | 'internal' | 'ambiguous_time' | 'network' | 'bad_response' | (string & {});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly fieldErrors: Record<string, string> | undefined,
    readonly details: Record<string, unknown> | undefined,
    readonly correlationId: string | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isNetwork() {
    return this.code === 'network';
  }
  /** Worth retrying the same request (same idempotency key). */
  get isTransient() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Human message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong. Try again.';
}

let csrfToken: string | null = null;
let csrfRefresher: (() => Promise<string | null>) | null = null;
export function setCsrfToken(t: string | null) {
  csrfToken = t;
}
export function setCsrfRefresher(fn: (() => Promise<string | null>) | null) {
  csrfRefresher = fn;
}

// Idempotency keys kept per (method, path, body) until the action reaches a definitive outcome,
// so a retry of the *same* user action reuses its key and a changed request gets a new one.
const pendingKeys = new Map<string, string>();
export function clearPendingKeys() {
  pendingKeys.clear();
}

// The workspace this tab rendered. Sent as X-Workspace-Id so the server can refuse requests from a tab
// that is still showing another workspace (it is never authority; see workspace-sync.ts).
let expectedWorkspace: string | null = null;
export function setExpectedWorkspace(id: string | null) {
  expectedWorkspace = id;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** true => auto key per action; string => use this exact key. */
  idempotent?: boolean | string;
  signal?: AbortSignal;
  /** default true; public pages (invite preview) pass false. */
  redirectOn401?: boolean;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Let the request outlive the page (presence "left" on tab close). */
  keepalive?: boolean;
}

export function withQuery(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Re-verify at the identity provider (password + second factor) and come back here. */
export function stepUpHref(returnTo?: string): string {
  const here = returnTo ?? (typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search);
  return `/api/auth/step-up?returnTo=${encodeURIComponent(here)}`;
}

export function redirectToStepUp() {
  if (typeof window === 'undefined') return;
  window.location.assign(stepUpHref());
}

export function redirectToLogin() {
  if (typeof window === 'undefined') return;
  const here = window.location.pathname + window.location.search;
  if (window.location.pathname.startsWith('/login')) return;
  window.location.assign(`/login?returnTo=${encodeURIComponent(here)}`);
}

// Safe references of recent failed requests (ids only, no bodies), offered in "Report a problem" by explicit choice.
const recentRefs: Array<{ id: string; at: string; status: number }> = [];
export function recentCorrelationIds(): Array<{ id: string; at: string; status: number }> {
  return [...recentRefs];
}

async function parseError(res: Response): Promise<ApiError> {
  const correlation = res.headers.get('x-correlation-id');
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error */
  }
  const env = (body ?? {}) as { error?: { code?: string; message?: string; fieldErrors?: Record<string, string>; details?: Record<string, unknown> }; correlation_id?: string };
  const err = env.error;
  const fallback = res.status === 404 ? 'Not found.' : res.status >= 500 ? 'Something went wrong on our side. Try again.' : `Request failed (${res.status}). Try again.`;
  const ref = env.correlation_id ?? correlation;
  if (ref && res.status >= 400) {
    recentRefs.unshift({ id: ref, at: new Date().toISOString(), status: res.status });
    recentRefs.splice(10);
  }
  return new ApiError(
    res.status,
    err?.code ?? (res.status >= 500 ? 'internal' : 'bad_response'),
    err?.message ?? fallback,
    err?.fieldErrors ?? undefined,
    err?.details ?? undefined,
    env.correlation_id ?? correlation,
  );
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const url = withQuery(path, opts.query);
  const bodyJson = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const mutating = method !== 'GET';

  let keyId: string | null = null;
  let idemKey: string | null = null;
  if (opts.idempotent) {
    if (typeof opts.idempotent === 'string') idemKey = opts.idempotent;
    else {
      keyId = `${method} ${url} ${bodyJson ?? ''}`;
      idemKey = pendingKeys.get(keyId) ?? newKey();
      pendingKeys.set(keyId, idemKey);
    }
  }

  const doFetch = async (): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (bodyJson !== undefined) headers['Content-Type'] = 'application/json';
    if (mutating && csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (idemKey) headers['Idempotency-Key'] = idemKey;
    if (expectedWorkspace && !url.startsWith('/api/session')) headers['X-Workspace-Id'] = expectedWorkspace;
    return fetch(url, { method, headers, body: bodyJson, credentials: 'same-origin', signal: opts.signal, cache: 'no-store', keepalive: opts.keepalive });
  };

  let res: Response;
  try {
    res = await doFetch();
    // A stale CSRF token (e.g. session rotated in another tab): refresh once and retry.
    if (res.status === 403 && mutating && csrfRefresher) {
      const peek = res.clone();
      let code: string | undefined;
      try {
        code = ((await peek.json()) as { error?: { code?: string } }).error?.code;
      } catch {
        /* ignore */
      }
      if (code === 'csrf_failed') {
        const t = await csrfRefresher();
        if (t) {
          csrfToken = t;
          res = await doFetch();
        }
      }
    }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Can’t reach the server. Check your connection and try again.', undefined, undefined, null);
  }

  if (res.ok) {
    if (keyId) pendingKeys.delete(keyId);
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return (await res.text()) as unknown as T;
    return (await res.json()) as T;
  }

  const err = await parseError(res);
  // Workspace switched in another tab: drop everything and reload into the active workspace.
  if (err.code === 'conflict' && err.details?.reason === 'workspace_changed' && typeof window !== 'undefined') {
    pendingKeys.clear();
    expectedWorkspace = null;
    window.location.replace('/overview');
  }
  // Definitive outcomes clear the key; transient ones keep it so a retry is deduplicated server-side.
  if (keyId && !err.isTransient) pendingKeys.delete(keyId);
  // Sensitive action needs fresh authentication (401 step_up_required) or a verified second factor
  // (403 mfa_required): send the user to verify at the identity provider, then back to this page.
  if (err.code === 'step_up_required' && opts.redirectOn401 !== false) redirectToStepUp();
  else if (err.code === 'mfa_required' && mutating && opts.redirectOn401 !== false) redirectToStepUp();
  else if (res.status === 401 && opts.redirectOn401 !== false) redirectToLogin();
  throw err;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], init?: Omit<RequestOptions, 'method' | 'query' | 'body'>) =>
    apiFetch<T>(path, { ...init, method: 'GET', query }),
  post: <T>(path: string, body: unknown = {}, init?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...init, method: 'POST', body }),
  put: <T>(path: string, body: unknown, init?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...init, method: 'PUT', body }),
  patch: <T>(path: string, body: unknown, init?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...init, method: 'PATCH', body }),
  del: <T>(path: string, init?: Omit<RequestOptions, 'method' | 'body'>) => apiFetch<T>(path, { ...init, method: 'DELETE' }),
};

/** Safe same-origin relative path for returnTo parameters. */
export function safeReturnTo(v: string | null | undefined, fallback = '/overview'): string {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return fallback;
  return v;
}
