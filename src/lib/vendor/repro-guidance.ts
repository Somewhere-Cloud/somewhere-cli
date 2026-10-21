/**
 * Canonical repro-packet schema, validators and guidance map (`somewhere.repro/1`, tsk_da2dba3d).
 *
 * ONE source for both clients. The MCP server imports it directly; the CLI vendors it with a
 * sha256 manifest and a `--check` (the same pattern as runtime/source-lint.cjs). Ported from the
 * CLI's local module (somewhere-cli PR #67 @ 516b0fd1, Files e0e3e20d) without behaviour changes,
 * except buildRecordFromFields, which takes already-typed fields so each client keeps its own
 * capture while sharing every validator.
 *
 * A packet is built ONLY from typed, validated fields of a failure: never its message, hint, data,
 * arguments, request or response. A field that fails its validator is omitted, not cleaned.
 * Investigation steps are fixed argv arrays keyed by the validated code/operation; untrusted text
 * is never interpolated into a command. Nothing here uploads anything.
 *
 * Dependency-free and platform-neutral: no imports, no runtime APIs.
 */
export const REPRO_SCHEMA = 'somewhere.repro/1';
export const LAST_ERROR_FILE = 'last-error.json';
export const OMITTED = ['message', 'hint_text', 'stack', 'console', 'request_body', 'response_body', 'arguments', 'route_data',
  'sql', 'url_query', 'emails', 'headers', 'cookies', 'tokens', 'passwords', 'source', 'env'] as const;

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Leading alphanumeric: an id substituted into an investigate argv can never read as a flag. */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CLI_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,20})?$/;
/** Codes whose mutation may still be completing server-side (client.ts SERVER_SLOW is status 0). */
const UNKNOWN_CODES = new Set(['TIMEOUT', 'NETWORK_ERROR', 'SERVER_SLOW', 'DEPLOY_OUTCOME_UNKNOWN']);
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type Outcome = 'refused' | 'unknown' | 'failed';

/** The one structured detail a refusal may carry (agreed with Deploy f74, tsk_da2dba3d): where in the
 *  caller's own input the problem is, and the numeric limit. `path` is built by the platform from an
 *  index and a fixed key, never from flow text; anything that fails these shapes is dropped. */
export interface InvalidDetail { path: string; limit_ms?: number }
const INVALID_PATH = /^(actions|steps)(\[\d{1,4}\](\.[a-z_]{1,32})?)?$/;
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
  /** Shared with the MCP builder (f74): `kind` names the client, `version` is its semver or 'unknown'. */
  client: { kind: 'cli' | 'mcp'; version: string };
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
    if (ROUTE_WORDS.has(segment) || segment === ':id' || segment === ':seg') return segment;
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

/** An operation is kept only if it is already a template: `METHOD <routeTemplate fixed point>` or `tool:<name>`. */
export function safeOperation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('tool:')) return toolOperation(value.slice(5));
  const match = /^([A-Z]{3,6}) (\/\S{0,200})$/.exec(value);
  return match && METHODS.has(match[1]) && routeTemplate(match[2]) === match[2] ? value : undefined;
}

export function toolOperation(name: unknown): string | undefined {
  return typeof name === 'string' && TOOL_NAME.test(name) ? `tool:${name}` : undefined;
}

/** Command names only, e.g. ['browser', 'test'] → 'browser test'; anything else is dropped. */
export function commandPath(names: string[]): string | undefined {
  const kept = names.filter((name) => COMMAND_NAME.test(name)).slice(0, 4);
  return kept.length ? kept.join(' ') : undefined;
}


/** The typed fields a client has for one failure. Every one is re-validated here. */
export interface FailureFields {
  /** True only for a platform-originated failure (an API or tool error); false is a client-side error. */
  platform: boolean;
  code?: unknown;
  status?: unknown;
  operation?: unknown;
  tool?: unknown;
  requestId?: unknown;
  traceId?: unknown;
  projectId?: unknown;
  retry?: unknown;
  retryAfterMs?: unknown;
  responseIncomplete?: unknown;
  invalid?: unknown;
}

export interface RecordContext {
  client: { kind: 'cli' | 'mcp'; version: string };
  command?: string;
  startedAt?: number;
  now?: number;
}

/** Shared record builder. The CLI maps a CliApiError/PlatformToolError into FailureFields; the MCP
 *  server maps an upstream tool-error envelope. Same validators, same outcome rule. */
export function buildRecordFromFields(fields: FailureFields, context: RecordContext): ReproRecord {
  const code = fields.platform && typeof fields.code === 'string' && CODE.test(fields.code) ? fields.code : fields.platform ? 'UNCLASSIFIED' : 'CLI_ERROR';
  const status = safeStatus(fields.status);
  const operation = safeOperation(fields.operation) ?? (fields.tool !== undefined ? toolOperation(fields.tool) : undefined);
  const id = (value: unknown) => (typeof value === 'string' && OPAQUE_ID.test(value) ? value : undefined);
  const now = context.now ?? Date.now();
  const mutating = operation ? MUTATING.has(operation.split(' ')[0]) || operation.startsWith('tool:') : false;
  // A mutation with no status (a tool error, SERVER_SLOW's 0) or a 5xx may have landed: unknown, never retried.
  const outcome: Outcome = fields.responseIncomplete === true || UNKNOWN_CODES.has(code)
    || (mutating && (status === undefined || status >= 500)) ? 'unknown'
    : status !== undefined && status >= 400 && status < 500 ? 'refused' : 'failed';
  const version = CLI_VERSION.test(context.client.version) ? context.client.version : 'unknown';
  const record: ReproRecord = {
    schema: REPRO_SCHEMA, client: { kind: context.client.kind === 'mcp' ? 'mcp' : 'cli', version },
    captured_at: new Date(now).toISOString(), code, outcome,
  };
  if (context.command) { const command = commandPath(context.command.split(' ')); if (command) record.command = command; }
  if (status !== undefined) record.http_status = status;
  if (operation) record.operation = operation;
  const requestId = id(fields.requestId); if (requestId) record.request_id = requestId;
  const traceId = id(fields.traceId); if (traceId) record.trace_id = traceId;
  const projectId = id(fields.projectId); if (projectId) record.project_id = projectId;
  if (typeof fields.retry === 'boolean') record.retry = fields.retry;
  if (typeof fields.retryAfterMs === 'number' && Number.isInteger(fields.retryAfterMs) && fields.retryAfterMs >= 0) record.retry_after_ms = fields.retryAfterMs;
  if (context.startedAt && now >= context.startedAt) record.duration_ms = now - context.startedAt;
  const invalid = safeInvalid(fields.invalid); if (invalid) record.invalid = invalid;
  return record;
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
  if (/^POST \/deploy|^tool:project_deploy/.test(op) || /^(deploy|promote|rollback)\b/.test(record.command ?? '')) {
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
