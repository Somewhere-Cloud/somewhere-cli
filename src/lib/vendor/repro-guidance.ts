



















export const REPRO_SCHEMA = 'somewhere.repro/1';
export const LAST_ERROR_FILE = 'last-error.json';
export const OMITTED = ['message', 'hint_text', 'stack', 'console', 'request_body', 'response_body', 'arguments', 'route_data',
  'sql', 'url_query', 'headers', 'cookies', 'source', 'env'] as const;

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CLI_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,20})?$/;

const UNKNOWN_CODES = new Set(['TIMEOUT', 'NETWORK_ERROR', 'SERVER_SLOW', 'DEPLOY_OUTCOME_UNKNOWN']);
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type Outcome = 'refused' | 'unknown' | 'failed';




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



const ROUTE_WORDS = new Set(['app', 'attach', 'auth', 'browser', 'check-handler', 'cli-logout', 'cli-pair', 'connect', 'connection', 'create', 'cron',
  'db', 'deploy', 'deploys', 'disconnect', 'domains', 'dump', 'email', 'env', 'errors', 'export', 'feedback', 'files', 'fs', 'github', 'groups',
  'hosted', 'inbox', 'installations', 'jobs', 'keys', 'logs', 'me', 'members', 'messages', 'notices', 'platform-feedback', 'postgres', 'preview',
  'previews', 'pricing', 'projects', 'promote', 'query', 'refresh', 'releases', 'rollback', 'rows', 'run', 'schema', 'secrets', 'sessions', 'source',
  'status', 'tables', 'tasks', 'test', 'test-inbox', 'test-users', 'upload', 'urls', 'users', 'verify', 'versions', 'whoami']);


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


export function safeOperation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('tool:')) return toolOperation(value.slice(5));
  const match = /^([A-Z]{3,6}) (\/\S{0,200})$/.exec(value);
  return match && METHODS.has(match[1]) && routeTemplate(match[2]) === match[2] ? value : undefined;
}

export function toolOperation(name: unknown): string | undefined {
  return typeof name === 'string' && TOOL_NAME.test(name) ? `tool:${name}` : undefined;
}


export function commandPath(names: string[]): string | undefined {
  const kept = names.filter((name) => COMMAND_NAME.test(name)).slice(0, 4);
  return kept.length ? kept.join(' ') : undefined;
}



export interface FailureFields {

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



export function buildRecordFromFields(fields: FailureFields, context: RecordContext): ReproRecord {
  const code = fields.platform && typeof fields.code === 'string' && CODE.test(fields.code) ? fields.code : fields.platform ? 'UNCLASSIFIED' : 'CLI_ERROR';
  const status = safeStatus(fields.status);
  const operation = safeOperation(fields.operation) ?? (fields.tool !== undefined ? toolOperation(fields.tool) : undefined);
  const id = (value: unknown) => (typeof value === 'string' && OPAQUE_ID.test(value) ? value : undefined);
  const now = context.now ?? Date.now();
  const mutating = operation ? MUTATING.has(operation.split(' ')[0]) || operation.startsWith('tool:') : false;

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


function guidanceFor(record: ReproRecord): Guidance {
  const op = record.operation ?? '';



  const project = record.project_id ? ['--project', record.project_id] : ['--project', '<PROJECT>'];


  if (record.code === 'FUNCTION_ERROR' || record.code === 'CONTEXT_BUILD_FAILED') {
    const trace = record.trace_id && /^[0-9a-f]{32}$/.test(record.trace_id) ? record.trace_id : '<TRACE_ID>';
    return { surface: 'function_crash',
      investigate: [['somewhere', 'logs', ...project, '--trace', trace]],
      recipe: ['FUNCTION_ERROR usually means the handler\'s own code threw; the stack in the owner\'s logs shows whether it points into the platform, which is what makes it a platform bug.',
        'Resending the failed request can repeat writes: the handler may have written data before it threw.',
        'Reproduction recipe, not run: a disposable test project without customer data, the same method and route with a synthetic body of the same shape (<FIELD>: <PLACEHOLDER>), read back with somewhere logs --project <TEST_PROJECT> --trace <TRACE_ID>'] };
  }
  if (op === 'tool:site_verify' || /^POST \/browser(\/|$)|^tool:browser|^POST \/verify|^tool:verify/.test(op) || /^(browser|verify)\b/.test(record.command ?? '')) {
    return { surface: 'browser_verify',
      investigate: [['somewhere', 'verify', '--schema'], ['somewhere', 'docs', 'browser']],
      recipe: ['somewhere init --bare --name <TEST_PROJECT> creates a disposable test project',
        'A minimal flow, <FLOW_FILE>, holds one action of the same kind and no real data',
        'somewhere verify --project <TEST_PROJECT> --flow <FLOW_FILE> --json reports the code to compare with this one'] };
  }
  if (/^POST \/deploy|^tool:project_deploy/.test(op) || /^(deploy|promote|rollback)\b/.test(record.command ?? '')) {
    return { surface: 'deploy',
      investigate: [['somewhere', 'status', ...project], ['somewhere', 'logs', ...project]],
      recipe: ['Re-running the original deploy before its outcome is known can publish it twice.',
        'Its result: somewhere status --project <PROJECT> and somewhere call project_deploy_log with {"version": <VERSION>}',
        'Reproduction recipe, not run: a disposable test project with placeholder source, somewhere deploy --project <TEST_PROJECT>'] };
  }
  if (/\/auth\/|^tool:auth_/.test(op)) {
    return { surface: 'function_auth',
      investigate: [['somewhere', 'errors', ...project], ['somewhere', 'logs', ...project]],
      recipe: ['somewhere test-users prepare <ACTOR> creates a preverified test user on a disposable project',
        'Reproduction recipe, not run: the same sign-in step in a browser with that state, using placeholder data only'] };
  }
  return { surface: 'general', investigate: [['somewhere', 'logs', ...project]],
    recipe: ['Reproduction recipe, not run: the same command shape on a disposable test project with placeholder input <INPUT>'] };
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
      steps: record.outcome === 'unknown' ? ['The outcome is unknown: the operation may have completed, so a blind retry can repeat it.', ...guidance.recipe] : guidance.recipe,
      investigate: guidance.investigate },
    submit: { destination: 'support_ticket', automatic: false, how: 'Not submitted automatically; POST /v1/platform-feedback (support_ticket where that tool is available) accepts this packet as a platform bug report.' },
  };
  return scrubbed(packet);
}


const SECRET_SHAPES = [/smt_[A-Za-z0-9]/, /eyJ[A-Za-z0-9_-]{8,}\./, /sk_(live|test)_/, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i, /password/i, /bearer\s/i, /\?[^"]*=/];
function scrubbed(packet: ReproPacket): ReproPacket {
  const text = JSON.stringify(packet.collected);
  if (SECRET_SHAPES.some((shape) => shape.test(text))) throw new Error('Refusing to build a repro packet: a collected field looked like a secret. Nothing was written.');
  return packet;
}
