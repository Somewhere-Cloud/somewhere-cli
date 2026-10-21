/**
 * Redacted repro packet for agent-ready errors (tsk_da2dba3d).
 *
 * The packet is built ONLY from typed, validated fields of a failure: never from its message,
 * hint, data, the command's arguments, the request or response, or anything the CLI printed. A
 * field that fails its validator is omitted, not cleaned. The final regex scrub is a second line
 * of defence only. Investigation steps are fixed argument arrays from a static map keyed by the
 * validated code/operation; untrusted text is never interpolated into a command. Nothing is
 * uploaded: submitting is a separate, deliberate action.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliConfigDir } from './config.js';

export const REPRO_SCHEMA = 'somewhere.repro/1';
export const LAST_ERROR_FILE = 'last-error.json';
export const OMITTED = ['message', 'hint_text', 'stack', 'console', 'request_body', 'response_body', 'arguments', 'route_data',
  'sql', 'url_query', 'emails', 'headers', 'cookies', 'tokens', 'passwords', 'source', 'env'] as const;

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type Outcome = 'refused' | 'unknown' | 'failed';

/** The one structured detail a refusal may carry (agreed with Deploy f74, tsk_da2dba3d): where in the
 *  caller's own input the problem is, and the numeric limit. `path` is built by the platform from an
 *  index and a fixed key, never from flow text; anything that fails these shapes is dropped. */
export interface InvalidDetail { path: string; limit_ms?: number }
const INVALID_PATH = /^(actions|steps)\[\d{1,4}\](\.[a-z_]{1,32})?$/;
export function safeInvalid(value: unknown): InvalidDetail | undefined {
  const v = value as { path?: unknown; limit_ms?: unknown } | null;
  if (!v || typeof v !== 'object' || typeof v.path !== 'string' || !INVALID_PATH.test(v.path)) return undefined;
  const out: InvalidDetail = { path: v.path };
  if (typeof v.limit_ms === 'number' && Number.isSafeInteger(v.limit_ms) && v.limit_ms > 0) out.limit_ms = v.limit_ms;
  return out;
}
export function safeCode(value: unknown): string | undefined { return typeof value === 'string' && CODE.test(value) ? value : undefined; }
export function safeStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}
export interface ReproRecord {
  schema: typeof REPRO_SCHEMA;
  cli_version: string;
  captured_at: string;
  command?: string;
  code: string;
  http_status?: number;
  operation?: string;
  request_id?: string;
  trace_id?: string;
  project_id?: string;
  retry?: boolean;
  retry_after_ms?: number;
  outcome: Outcome;
  duration_ms?: number;
  invalid?: InvalidDetail;
}

/** Static API route words. Anything else in a path (a slug, a file path, a name) is never copied:
 *  it becomes `:id` (id-shaped) or `:seg`. A word missing here only makes a template less specific. */
const ROUTE_WORDS = new Set(['app', 'attach', 'auth', 'browser', 'check-handler', 'cli-logout', 'cli-pair', 'connect', 'connection', 'create', 'cron',
  'db', 'deploy', 'deploys', 'disconnect', 'domains', 'dump', 'email', 'env', 'errors', 'export', 'feedback', 'files', 'fs', 'github', 'groups',
  'hosted', 'inbox', 'installations', 'jobs', 'keys', 'logs', 'me', 'members', 'messages', 'notices', 'platform-feedback', 'postgres', 'preview',
  'previews', 'pricing', 'projects', 'promote', 'query', 'refresh', 'releases', 'rollback', 'rows', 'run', 'schema', 'secrets', 'sessions', 'source',
  'status', 'tables', 'tasks', 'test', 'test-inbox', 'test-users', 'upload', 'urls', 'users', 'verify', 'versions', 'whoami']);

/** `/projects/<uuid>/deploys/rel_x?q=secret` → `/projects/:id/deploys/:id`. */
export function routeTemplate(path: string): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined;
  const bare = path.split(/[?#]/)[0];
  const segments = bare.split('/').slice(1).map((segment) => {
    if (ROUTE_WORDS.has(segment)) return segment;
    if (/^[A-Za-z0-9._:-]{1,128}$/.test(segment)) return ':id';
    return ':seg';
  });
  const template = '/' + segments.join('/');
  return template.length <= 200 ? template : undefined;
}

export function operationLabel(method: string, path: string): string | undefined {
  const verb = String(method).toUpperCase();
  const route = routeTemplate(path);
  return METHODS.has(verb) && route ? `${verb} ${route}` : undefined;
}

export function toolOperation(name: unknown): string | undefined {
  return typeof name === 'string' && TOOL_NAME.test(name) ? `tool:${name}` : undefined;
}

/** Command names only, e.g. ['browser', 'test'] → 'browser test'; anything else is dropped. */
export function commandPath(names: string[]): string | undefined {
  const kept = names.filter((name) => COMMAND_NAME.test(name)).slice(0, 4);
  return kept.length ? kept.join(' ') : undefined;
}

interface TypedFailure { name?: string; code?: unknown; statusCode?: unknown; meta?: Record<string, unknown>; operation?: unknown; tool?: unknown; data?: unknown; invalid?: unknown }

/** Build the record from a failure's typed fields. `cause` is never read for text. */
export function buildRecord(cause: unknown, context: { cliVersion: string; command?: string; projectId?: string; startedAt?: number; now?: number }): ReproRecord {
  const typed = (cause && typeof cause === 'object' ? cause : {}) as TypedFailure;
  const platform = typed.name === 'CliApiError' || typed.name === 'PlatformToolError';
  const code = platform && typeof typed.code === 'string' && CODE.test(typed.code) ? typed.code : platform ? 'UNCLASSIFIED' : 'CLI_ERROR';
  const meta = (typed.meta && typeof typed.meta === 'object' ? typed.meta : {}) as Record<string, unknown>;
  const status = typeof typed.statusCode === 'number' && Number.isInteger(typed.statusCode) && typed.statusCode >= 100 && typed.statusCode <= 599 ? typed.statusCode : undefined;
  const operation = typeof typed.operation === 'string' && /^(GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9/:_-]{0,200}$|^tool:[a-z][a-z0-9_]{0,63}$/.test(typed.operation) ? typed.operation
    : typed.name === 'PlatformToolError' ? toolOperation(typed.tool) : undefined;
  const id = (value: unknown) => (typeof value === 'string' && OPAQUE_ID.test(value) ? value : undefined);
  const now = context.now ?? Date.now();
  const mutating = operation ? MUTATING.has(operation.split(' ')[0]) || operation.startsWith('tool:') : false;
  const outcome: Outcome = meta.responseBodyIncomplete === true || code === 'TIMEOUT' || code === 'NETWORK_ERROR'
    || (mutating && status !== undefined && status >= 500) ? 'unknown'
    : status !== undefined && status >= 400 && status < 500 ? 'refused' : 'failed';
  const record: ReproRecord = { schema: REPRO_SCHEMA, cli_version: context.cliVersion, captured_at: new Date(now).toISOString(), code, outcome };
  if (context.command) record.command = context.command;
  if (status !== undefined) record.http_status = status;
  if (operation) record.operation = operation;
  const requestId = id(meta.requestId); if (requestId) record.request_id = requestId;
  const traceId = id(meta.traceId); if (traceId) record.trace_id = traceId;
  const projectId = id(context.projectId); if (projectId) record.project_id = projectId;
  if (typeof meta.retry === 'boolean') record.retry = meta.retry;
  if (typeof meta.retryAfterMs === 'number' && Number.isInteger(meta.retryAfterMs) && meta.retryAfterMs >= 0) record.retry_after_ms = meta.retryAfterMs;
  if (context.startedAt && now >= context.startedAt) record.duration_ms = now - context.startedAt;
  const invalid = safeInvalid(typed.invalid ?? (typed.data as { invalid?: unknown } | undefined)?.invalid);
  if (invalid) record.invalid = invalid;
  return record;
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

/** Re-validate on read: a hand-edited file cannot smuggle a field into the packet. */
export function readLastError(): ReproRecord | null {
  const path = join(cliConfigDir(), LAST_ERROR_FILE);
  if (!existsSync(path)) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (raw?.schema !== REPRO_SCHEMA || typeof raw.code !== 'string' || !CODE.test(raw.code)) return null;
  const out: ReproRecord = { schema: REPRO_SCHEMA, cli_version: typeof raw.cli_version === 'string' && /^\d+\.\d+\.\d+/.test(raw.cli_version) ? raw.cli_version.slice(0, 32) : 'unknown',
    captured_at: typeof raw.captured_at === 'string' && Number.isFinite(Date.parse(raw.captured_at)) ? new Date(Date.parse(raw.captured_at)).toISOString() : new Date(0).toISOString(),
    code: raw.code, outcome: raw.outcome === 'refused' || raw.outcome === 'unknown' ? raw.outcome : 'failed' };
  if (typeof raw.command === 'string') { const c = commandPath(raw.command.split(' ')); if (c) out.command = c; }
  if (typeof raw.http_status === 'number' && Number.isInteger(raw.http_status) && raw.http_status >= 100 && raw.http_status <= 599) out.http_status = raw.http_status;
  if (typeof raw.operation === 'string' && /^(GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9/:_-]{0,200}$|^tool:[a-z][a-z0-9_]{0,63}$/.test(raw.operation)) out.operation = raw.operation;
  for (const key of ['request_id', 'trace_id', 'project_id'] as const) if (typeof raw[key] === 'string' && OPAQUE_ID.test(raw[key] as string)) out[key] = raw[key] as string;
  if (typeof raw.retry === 'boolean') out.retry = raw.retry;
  if (typeof raw.retry_after_ms === 'number' && Number.isInteger(raw.retry_after_ms) && raw.retry_after_ms >= 0) out.retry_after_ms = raw.retry_after_ms;
  if (typeof raw.duration_ms === 'number' && Number.isInteger(raw.duration_ms) && raw.duration_ms >= 0) out.duration_ms = raw.duration_ms;
  const invalid = safeInvalid(raw.invalid); if (invalid) out.invalid = invalid;
  return out;
}

type Step = string[];
interface Guidance { surface: string; investigate: Step[]; recipe: string[] }

/** Static guidance by surface. Placeholders stay literal (<…>); ids are substituted only into fixed slots. */
function guidanceFor(record: ReproRecord): Guidance {
  const op = record.operation ?? '';
  // Every step uses only commands and flags verified to exist; ids go in fixed slots. Trace and
  // request ids stay in `collected` for support: no log reader filters by them today.
  const project = record.project_id ? ['--project', record.project_id] : ['--project', '<PROJECT>'];
  if (/^POST \/browser(\/|$)|^tool:browser|^POST \/verify|^tool:verify/.test(op) || /^(browser|verify)\b/.test(record.command ?? '')) {
    return { surface: 'browser_verify',
      investigate: [['somewhere', 'verify', '--schema'], ['somewhere', 'docs', 'browser']],
      recipe: ['Create a disposable test project: somewhere init --bare --name <TEST_PROJECT>',
        'Write a minimal flow reproducing the shape: <FLOW_FILE> with one action of the same kind (no real data)',
        'Run: somewhere verify --project <TEST_PROJECT> --flow <FLOW_FILE> --json and compare the code'] };
  }
  if (/^POST \/deploy|^tool:project_deploy|^(deploy|promote|rollback)\b/.test(`${op} ${record.command ?? ''}`.trim())) {
    return { surface: 'deploy',
      investigate: [['somewhere', 'status', ...project], ['somewhere', 'logs', ...project]],
      recipe: ['Do NOT re-run the original deploy until its outcome is known.',
        'Read its result: somewhere status --project <PROJECT>, then somewhere call project_deploy_log with {"version": <VERSION>}',
        'Reproduce on a disposable test project with placeholder source: somewhere deploy --project <TEST_PROJECT>'] };
  }
  if (/\/auth\/|^tool:auth_/.test(op)) {
    return { surface: 'function_auth',
      investigate: [['somewhere', 'errors', ...project], ['somewhere', 'logs', ...project]],
      recipe: ['Prepare a preverified test user on a disposable project: somewhere test-users prepare <ACTOR>',
        'Repeat the same sign-in step in a browser with that state, using placeholder data only'] };
  }
  return { surface: 'general', investigate: [['somewhere', 'logs', ...project]],
    recipe: ['Reproduce the same command shape on a disposable test project with placeholder input <INPUT>'] };
}

export interface ReproPacket {
  schema: typeof REPRO_SCHEMA;
  collected: ReproRecord;
  omitted: readonly string[];
  surface: string;
  recipe: { kind: 'synthetic'; rerun_original: boolean; steps: string[]; investigate: Step[] };
  submit: { destination: 'support_ticket'; automatic: false; how: string };
}

export function buildPacket(record: ReproRecord): ReproPacket {
  const guidance = guidanceFor(record);
  const mutating = record.operation ? /^(POST|PUT|PATCH|DELETE) |^tool:/.test(record.operation) : false;
  const packet: ReproPacket = {
    schema: REPRO_SCHEMA, collected: record, omitted: OMITTED, surface: guidance.surface,
    recipe: { kind: 'synthetic', rerun_original: !mutating && record.outcome === 'refused' && record.retry === true,
      steps: record.outcome === 'unknown' ? ['The outcome is unknown: inspect before doing anything else; never retry it blindly.', ...guidance.recipe] : guidance.recipe,
      investigate: guidance.investigate },
    submit: { destination: 'support_ticket', automatic: false, how: 'Review this packet, then submit it deliberately as a platform bug.' },
  };
  return scrubbed(packet);
}

/** Defence in depth only: refuse a packet whose serialized form looks like it carries a secret. */
const SECRET_SHAPES = [/smt_[A-Za-z0-9]/, /eyJ[A-Za-z0-9_-]{8,}\./, /sk_(live|test)_/, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i, /password/i, /bearer\s/i, /\?[^"]*=/];
function scrubbed(packet: ReproPacket): ReproPacket {
  const text = JSON.stringify(packet.collected);
  if (SECRET_SHAPES.some((shape) => shape.test(text))) throw new Error('Refusing to build a repro packet: a collected field looked like a secret. Nothing was written.');
  return packet;
}
