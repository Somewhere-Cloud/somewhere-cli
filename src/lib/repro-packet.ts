/**
 * Redacted repro packet for agent-ready errors (tsk_da2dba3d): the CLI's capture around the shared
 * module. Every validator, the outcome rule, the guidance map and the packet builder live in the
 * platform's shared/repro-guidance.ts, vendored byte-identical into ./vendor/ (see
 * scripts/vendor-repro-guidance.mjs). This file only maps the CLI's error types into typed fields and
 * owns the local file; nothing here reads a message, hint, data, argument or body.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cliConfigDir } from './config.js';
import { buildRecordFromFields, LAST_ERROR_FILE, operationLabel, REPRO_SCHEMA, safeCode, safeStatus, type ReproRecord } from './vendor/repro-guidance.js';

export * from './vendor/repro-guidance.js';

interface TypedFailure { name?: string; code?: unknown; statusCode?: unknown; meta?: Record<string, unknown>; operation?: unknown; tool?: unknown; data?: unknown; invalid?: unknown }

/** Map a CliApiError/PlatformToolError (or anything else) into the shared builder. `cause` is never read for text. */
export function buildRecord(cause: unknown, context: { cliVersion: string; command?: string; projectId?: string; startedAt?: number; now?: number }): ReproRecord {
  const typed = (cause && typeof cause === 'object' ? cause : {}) as TypedFailure;
  const meta = (typed.meta && typeof typed.meta === 'object' ? typed.meta : {}) as Record<string, unknown>;
  return buildRecordFromFields({
    platform: typed.name === 'CliApiError' || typed.name === 'PlatformToolError',
    code: typed.code, status: typed.statusCode, operation: typed.operation,
    tool: typed.name === 'PlatformToolError' ? typed.tool : undefined,
    requestId: meta.requestId, traceId: meta.traceId, projectId: context.projectId,
    retry: meta.retry, retryAfterMs: meta.retryAfterMs, responseIncomplete: meta.responseBodyIncomplete,
    invalid: typed.invalid ?? (typed.data as { invalid?: unknown } | undefined)?.invalid,
  }, { client: { kind: 'cli', version: context.cliVersion }, command: context.command, startedAt: context.startedAt, now: context.now });
}

/** The CLOSED set of codes the function runtime itself answers or reports for a failure (tsk_fca1267b):
 *  its own crash codes, the scope rejection and DB_EXPOSED_SERVER_ERROR_CODES. An app's own err.code is
 *  owner text (it may hold anything, a key included, and still match the CODE shape), so it is never
 *  copied into a packet: any code outside this set becomes APP_ERROR_CODE. */
export const RUNTIME_FAILURE_CODES: ReadonlySet<string> = new Set([
  'FUNCTION_ERROR', 'CONTEXT_BUILD_FAILED', 'FUNCTION_MODULE_LOAD_FAILED', 'RAW_SQL_CANNOT_BE_PLATFORM_SCOPED', 'DRAFT_EGRESS_DENIED',
  'DB_CONNECTION_NOT_READY', 'DB_COMMITTED_READ_FAILED', 'DB_WRITE_OUTCOME_UNKNOWN', 'IDEMPOTENCY_OUTCOME_UNAVAILABLE',
  'IDEMPOTENCY_RECEIPT_INVALID', 'IDEMPOTENCY_UNAVAILABLE', 'DRAFT_CONTEXT_INVALID', 'DRAFT_DB_NOT_ISOLATED', 'AUTH_VERIFY_UNAVAILABLE',
  'VISITOR_IDENTITY_UNAVAILABLE', 'VISITOR_CLAIM_OUTCOME_UNKNOWN', 'VISITOR_SIGN_OUT_UNCONFIRMED',
]);
export const APP_ERROR_CODE = 'APP_ERROR_CODE';
/** The packet code for a crash row: the server-recorded response_code, else the row's code, and only
 *  when it is in RUNTIME_FAILURE_CODES; otherwise APP_ERROR_CODE. */
export function runtimeFailureCode(data: Record<string, unknown>): string {
  for (const candidate of [data.response_code, data.code]) {
    if (typeof candidate === 'string' && RUNTIME_FAILURE_CODES.has(candidate)) return candidate;
  }
  return APP_ERROR_CODE;
}

/** A function failure the caller hit over HTTP (e.g. 500 FUNCTION_ERROR with its trace_id), rebuilt from the
 *  owner's own log rows for that trace. Reads ONLY data.response_code/data.code (mapped through
 *  RUNTIME_FAILURE_CODES), data.status, data.request_id, data.method and data.path (templated by the shared
 *  builder); the message, stack and every other field are never read.
 *  Rows come newest first; the newest reported failure wins. Null when no row reports one. */
export function buildCrashRecord(rows: unknown, context: { cliVersion: string; traceId: string; projectId?: string }): ReproRecord | null {
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = (row && typeof row === 'object' ? row : {}) as { level?: unknown; created_at?: unknown; data?: unknown };
    const d = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
    const status = safeStatus(d.status);
    if (r.level !== 'error' || (!safeCode(d.code) && !safeCode(d.response_code)) || status === undefined || status < 400) continue;
    const at = typeof r.created_at === 'string' ? Date.parse(r.created_at) : NaN;
    return buildRecordFromFields({
      platform: true, code: runtimeFailureCode(d), status,
      operation: typeof d.method === 'string' && typeof d.path === 'string' ? operationLabel(d.method, d.path) : undefined,
      requestId: d.request_id, traceId: context.traceId, projectId: context.projectId,
    }, { client: { kind: 'cli', version: context.cliVersion }, now: Number.isFinite(at) ? at : undefined });
  }
  return null;
}

export function writeLastError(record: ReproRecord): void {
  let tmp: string | undefined;
  let ownsTemp = false;
  try {
    const dir = cliConfigDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, LAST_ERROR_FILE);
    tmp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    ownsTemp = true;
    try { writeFileSync(fd, JSON.stringify(record) + '\n'); } finally { closeSync(fd); }
    renameSync(tmp, path);
    tmp = undefined;
  } catch {
    // Local diagnostics must never change a command's own failure.
  } finally {
    if (tmp && ownsTemp) { try { unlinkSync(tmp); } catch { /* best-effort private temporary cleanup */ } }
  }
}

/** Re-validate on read: every field goes back through the shared builder's validators, so a
 *  hand-edited file cannot smuggle a field into the packet. `commands` is the registered command
 *  tree's paths; a command outside it is dropped. Only the stored time, outcome and duration are
 *  kept from the file, each checked here. */
export function readLastError(commands: ReadonlySet<string> = new Set()): ReproRecord | null {
  const path = join(cliConfigDir(), LAST_ERROR_FILE);
  if (!existsSync(path)) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object' || raw.schema !== REPRO_SCHEMA || !safeCode(raw.code)) return null;
  const client = (raw.client && typeof raw.client === 'object' ? raw.client : {}) as Record<string, unknown>;
  const record = buildRecordFromFields({
    platform: true, code: raw.code, status: raw.http_status, operation: raw.operation,
    requestId: raw.request_id, traceId: raw.trace_id, projectId: raw.project_id,
    retry: raw.retry, retryAfterMs: raw.retry_after_ms, invalid: raw.invalid,
  }, {
    client: { kind: 'cli', version: typeof client.version === 'string' ? client.version : '' },
    command: typeof raw.command === 'string' && commands.has(raw.command) ? raw.command : undefined,
    now: typeof raw.captured_at === 'string' && Number.isFinite(Date.parse(raw.captured_at)) ? Date.parse(raw.captured_at) : 0,
  });
  record.outcome = raw.outcome === 'refused' || raw.outcome === 'unknown' ? raw.outcome : 'failed';
  if (typeof raw.duration_ms === 'number' && Number.isInteger(raw.duration_ms) && raw.duration_ms >= 0) record.duration_ms = raw.duration_ms;
  return record;
}
