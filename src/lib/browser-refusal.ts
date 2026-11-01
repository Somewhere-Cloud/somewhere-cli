import { CliApiError } from './client.js';
import { error, platformErrorEnvelope, printJsonError } from './output.js';

// A browser refusal's `data`, limited to what the platform's browser routes
// document for that exact refusal (worker/src/routes/browser.ts and
// utils/browser-abuse.ts, browser-pool-client.ts): each field belongs to one
// code and HTTP status, and each value must have its documented shape. Any
// other refusal — an authorization or not-found answer included — carries no
// data at all, so a session name can only come from the caller's own
// live-session limit. A field the platform adds later, or anything echoed
// from a request, stays out until it is named here (tsk_de3c2c25).

type Check = (value: unknown) => boolean;

const count: Check = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp: Check = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value);
const oneOf = (...values: string[]): Check => (value) => typeof value === 'string' && values.includes(value);
const isTrue: Check = (value) => value === true;
/** The route's own session name rule: 1–64 letters, digits, dot, dash or underscore. */
const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const sessionName: Check = (value) => typeof value === 'string' && SESSION_NAME.test(value);
const MAX_SESSION_NAMES = 50;

interface Profile {
  status: number;
  reason?: Check;
  fields: Record<string, Check>;
  sessionNames?: boolean;
}

const ADMISSION_COUNTS = { used: count, limit: count, requested: count, unconfirmed: count, held_until: timestamp };

/** One entry per documented refusal shape, keyed by code. */
const PROFILES: Record<string, Profile[]> = {
  BROWSER_SESSION_LIMIT: [
    { status: 429, reason: oneOf('concurrency_exhausted'), fields: { ...ADMISSION_COUNTS, reserved_for_verify: count } },
    { status: 429, reason: oneOf('live_sessions_exhausted'), fields: { limit: count, other_live_sessions: count }, sessionNames: true },
  ],
  BROWSER_DAILY_LIMIT: [
    { status: 429, reason: oneOf('runs_exhausted', 'duration_exhausted'), fields: ADMISSION_COUNTS },
  ],
  BROWSER_STARTUP_UNAVAILABLE: [
    { status: 503, fields: { outcome_unknown: isTrue, attempts: count, held_until: timestamp } },
    { status: 503, reason: oneOf('coordinator_unavailable'), fields: {} },
  ],
  BROWSER_STARTUP_RATE_LIMITED: [
    { status: 429, reason: oneOf('queue_timeout', 'queue_full', 'provider_rate_limited'), fields: {} },
  ],
  SESSION_TARGET_LOST: [
    { status: 409, fields: { session_id: sessionName } },
  ],
};

export function browserRefusalData(code: string, status: number, data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const source = data as Record<string, unknown>;
  const profile = (PROFILES[code] ?? []).find((candidate) =>
    candidate.status === status && (candidate.reason ? candidate.reason(source.reason) : source.reason === undefined));
  if (!profile) return undefined;
  const out: Record<string, unknown> = {};
  if (profile.reason) out.reason = source.reason;
  for (const [key, check] of Object.entries(profile.fields)) {
    if (check(source[key])) out[key] = source[key];
  }
  if (profile.sessionNames && Array.isArray(source.live_session_ids)) {
    out.live_session_ids = source.live_session_ids.filter(sessionName).slice(0, MAX_SESSION_NAMES);
  }
  return Object.keys(out).length ? out : undefined;
}

/** The same platform error with only its documented browser data, for the
 *  shared error envelope. Code, status, message, hint and request/retry meta
 *  are kept as they are. */
export function browserRefusalCause(err: unknown): unknown {
  if (!(err instanceof CliApiError)) return err;
  const safe = new CliApiError(err.code, err.message, err.statusCode, browserRefusalData(err.code, err.statusCode, err.data), err.hint, err.meta);
  const operation = (err as { operation?: unknown }).operation;
  if (operation !== undefined) Object.defineProperty(safe, 'operation', { value: operation, enumerable: false });
  return safe;
}

/**
 * Report a browser refusal. `--json` prints the shared platform error envelope
 * of the allowlisted copy plus the HTTP `status` beside the code (an agent
 * tells a 429 limit from a 503 unknown outcome without reading the message).
 * Text prints `text`, with the code/request line only where that call site
 * already printed it. Either way the failure goes through `error()`, so the
 * local failure record is kept; it never retries anything.
 */
export function reportBrowserRefusal(text: string, err: unknown, opts: { json?: boolean; textIds?: boolean }): void {
  const safe = browserRefusalCause(err);
  if (opts.json) {
    const envelope = platformErrorEnvelope(safe);
    if (envelope && safe instanceof CliApiError) {
      printJsonError(envelope.code, envelope.message, {
        ...(safe.statusCode > 0 ? { status: safe.statusCode } : {}),
        ...envelope.extra,
      });
    }
    error(text, safe);
    return;
  }
  error(text, opts.textIds ? safe : undefined, safe);
}
