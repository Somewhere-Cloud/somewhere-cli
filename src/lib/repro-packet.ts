/**
 * Redacted repro packet for agent-ready errors (tsk_da2dba3d): the CLI's capture around the shared
 * module. Every validator, the outcome rule, the guidance map and the packet builder live in the
 * platform's shared/repro-guidance.ts, vendored byte-identical into ./vendor/ (see
 * scripts/vendor-repro-guidance.mjs). This file only maps the CLI's error types into typed fields and
 * owns the local file; nothing here reads a message, hint, data, argument or body.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliConfigDir } from './config.js';
import { buildRecordFromFields, LAST_ERROR_FILE, REPRO_SCHEMA, safeCode, type ReproRecord } from './vendor/repro-guidance.js';

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

export function writeLastError(record: ReproRecord): void {
  try {
    const dir = cliConfigDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, LAST_ERROR_FILE);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    // Local diagnostics must never change a command's own failure.
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
