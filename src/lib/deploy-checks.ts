import { cliInvocation } from './cli-invocation.js';
import { CliApiError, type ApiClient } from './client.js';
import { interactivePollDelay } from './poll-delay.js';
import { checkSummaryExitCode, summarizeChecks, type CheckSummary } from './check-summary.js';

/**
 * After a live deploy the platform runs its access check in the background and
 * answers the deploy with checks: { status: 'running', read: 'GET /v1/deploy/log?…' }.
 * A deploy never waits on it (it warns, never blocks; architect 2026-11-20): it prints one line saying the check is
 * running and how to read it. `somewhere test` reads the stored result, waiting only while that run is still going.
 */
export interface CheckLine {
  name: string;
  as?: string;
  method?: string;
  path?: string;
  status?: number;
  expected?: string;
  pass: boolean;
  outcome?: CheckSummary['outcome'];
  detail?: string;
  request?: { method: string; url: string; body?: unknown };
  responses?: Array<{ status: number; request_id?: string; observed: string; request?: CheckLine['request'] }>;
}
interface Finding { kind: string; table?: string; via?: string; status?: number; request_id?: string; left_behind?: string }

export interface AccessCheck {
  status: 'pending' | 'checked' | 'unavailable' | string;
  sentence: string | null;
  scope?: 'partial';
  selection?: string;
  checked_parts?: string[];
  findings?: Finding[];
  checks?: CheckLine[];
  passed?: boolean;
  checked_at?: string | null;
  routes_checked?: number;
  routes_discovered?: number | null;
  not_checked?: {
    routes_without_read_check: string[] | null;
    routes_without_write_check: string[] | null;
    schedules_not_run: string[] | null;
    other: string[];
  };
}

export interface DeployChecks {
  status?: string;
  read?: string;
}

/** The API path (without /v1) and query the platform named in checks.read. */
export function parseChecksRead(read: string): { path: string; query: Record<string, string> } | null {
  const match = /^GET\s+(\/\S+)$/.exec(read.trim());
  if (!match) return null;
  const url = new URL(match[1], 'https://api.invalid');
  return { path: url.pathname.replace(/^\/v1(?=\/)/, ''), query: Object.fromEntries(url.searchParams) };
}

/** The last access_check read: settled, still pending at the deadline, or null
 *  when no read succeeded. */
export async function awaitDeployChecks(
  client: Pick<ApiClient, 'call'>,
  checks: DeployChecks,
  opts: { waitMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
    readStored?: boolean; firstDelayMs?: number } = {},
): Promise<AccessCheck | null> {
  const target = typeof checks.read === 'string' ? parseChecksRead(checks.read) : null;
  if (!target) return null;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.waitMs ?? TEST_CHECKS_WAIT_MS);
  let last: AccessCheck | null = null;
  let delay = opts.firstDelayMs ?? 0;
  let rateLimited = false;
  for (let attempt = 0; now() + delay <= deadline; attempt++) {
    if (delay) await sleep(delay);
    let retryAfter = 0;
    try {
      const read = await client.call<{ access_check?: AccessCheck | null }>('GET', target.path, undefined, target.query,
        { timeoutMs: Math.max(1000, deadline - now()), onRetryAfter: (ms) => { retryAfter = ms; } });
      if (read?.access_check) last = read.access_check;
      if (last && last.status !== 'pending') return last;
      if (opts.readStored && !last && !retryAfter) return null;
    } catch (error) {
      if (error instanceof CliApiError) retryAfter = Math.max(retryAfter, error.meta.retryAfterMs ?? 0);
      if (opts.readStored && !last && !retryAfter && !rateLimited) return null;
      rateLimited ||= retryAfter > 0;
    }
    delay = Math.max(opts.pollMs ?? interactivePollDelay(attempt), retryAfter);
  }
  return last ?? (rateLimited && opts.readStored ? { status: 'unavailable', sentence: 'The platform asked us to wait before reading the check again.' } : null);
}

/** The one line a deploy prints; the deploy never waits for the check. */
export const DEPLOY_CHECKS_RUNNING = `Checks: running in the background; \`${cliInvocation()} test\` shows the result.`;

export const TEST_CHECKS_WAIT_MS = 150_000;

/** `somewhere test`: the live release's stored check result (the run every deploy starts). While that run is still
 *  going it waits for it, up to 150 s. With `again`, or when the release has no result yet, it starts a fresh run
 *  (POST /v1/deploy/checks) and waits for that. Null or pending means it had not finished. */
export async function runChecksNow(
  client: Pick<ApiClient, 'call'>,
  projectId: string,
  opts: Parameters<typeof awaitDeployChecks>[2] & { again?: boolean; only?: string } = {},
): Promise<AccessCheck | null> {
  if (!opts.again && opts.only === undefined) {
    const read = `GET /v1/deploy/log?project_id=${encodeURIComponent(projectId)}`;
    const stored = await awaitDeployChecks(client, { read }, { ...opts, readStored: true });
    if (stored) return stored;
  }
  let firstDelayMs = 0;
  const started = await client.call<{ status?: string; version?: number; read?: string; scope?: string; selection?: string }>(
    'POST', opts.only === undefined ? '/deploy/checks' : '/deploy/checks/targeted', { project_id: projectId, ...(opts.only !== undefined ? { check: opts.only } : {}) },
    undefined, { onRetryAfter: (ms) => { firstDelayMs = ms; } },
  );
  if (opts.only !== undefined && (started?.scope !== 'partial' || started.selection !== opts.only)) {
    return partialCheckUnavailable(opts.only, 'The platform did not confirm a targeted check.');
  }
  const result = await awaitDeployChecks(client, { read: started?.read }, { ...opts, firstDelayMs });
  if (opts.only !== undefined && (result?.scope !== 'partial' || result.selection !== opts.only)) {
    return partialCheckUnavailable(opts.only, 'The platform did not return a result for the selected check.');
  }
  return result;
}

const selectionLabel = (selection: string) => selection === 'access' ? 'Access probes' : selection === 'crawl' ? 'Browser page crawl' : selection;

export function partialCheckUnavailable(selection: string, sentence: string): AccessCheck {
  return {
    status: 'unavailable', scope: 'partial', selection, checked_parts: [], sentence,
    not_checked: {
      routes_without_read_check: null, routes_without_write_check: null, schedules_not_run: null,
      other: ['Access probes', 'Browser page crawl', 'Saved checks'],
    },
  };
}

function lineOutcome(line: CheckLine): CheckSummary['outcome'] {
  if (line.outcome) return line.outcome;
  if (line.pass) return 'passed';
  // Stored results from an older check engine contain one attempt only.
  return line.as === 'stranger' || line.as === 'signed_out' && line.method !== 'flow' ? 'could_not_check' : 'failed';
}

const cleanupFindings = (check: AccessCheck | null) => (check?.findings ?? []).filter((f) => f.kind === 'cleanup');
const functionWarnings = (check: AccessCheck | null) => (check?.findings ?? []).filter((finding) =>
  finding.kind === 'function_http_error' || finding.kind === 'crash' && Boolean(finding.request_id));

export function deployChecksSummary(check: AccessCheck | null): CheckSummary {
  const lines = check?.checks ?? [];
  const counts = { passed: 0, failed: 0, could_not_check: cleanupFindings(check).length, warnings: functionWarnings(check).length };
  for (const line of lines) counts[lineOutcome(line)]++;
  if (check?.status !== 'checked' || !lines.length || check.passed === false && !counts.failed && !counts.could_not_check
      && (!check.findings?.length || check.findings.some((finding) => finding.kind !== 'crash'))) counts.could_not_check++;
  return summarizeChecks(counts);
}

export function checksJsonReport(check: AccessCheck | null) {
  const summary = deployChecksSummary(check);
  const checked = check?.checks ?? [];
  const confirmedAccessFailure = checked.some((line) => line.outcome === 'failed' && (line.as === 'stranger' || line.as === 'signed_out') && line.method !== 'flow');
  const findings = (check?.findings ?? []).filter((item) =>
    (item.kind !== 'crash' || Boolean(item.request_id))
    && (item.kind !== 'read' && item.kind !== 'write' || confirmedAccessFailure));
  return {
    ...check, checks: checked.map((line) => ({ ...line, pass: lineOutcome(line) === 'passed', outcome: lineOutcome(line) })),
    findings, sentence: findings.length !== (check?.findings?.length ?? 0) ? null : check?.sentence ?? null,
    passed: summary.outcome === 'passed', ...summary, not_checked: check?.not_checked ?? null,
  };
}

function resultEvidence(line: CheckLine): string[] {
  const request = line.request ?? { method: line.method, url: line.path };
  const responses = line.responses?.length ? line.responses : [{ status: line.status, observed: line.detail }];
  return [
    `  Did: ${request.method ?? 'check'} ${request.url ?? line.name} as ${line.as ?? 'the test actor'}`,
    ...(line.expected ? [`  Expected: ${line.expected}`] : []),
    ...responses.map((r, i) => `  Response ${i + 1}: ${r.status ? `HTTP ${r.status}` : 'no HTTP status'}${r.observed ? ` — ${r.observed}` : ''}${'request_id' in r && r.request_id ? ` (request ID ${r.request_id})` : ''}`),
    `  Reproduce: ${JSON.stringify(request)}`,
    ...responses.flatMap((r) => 'request' in r && r.request ? [`  Confirmation request: ${JSON.stringify(r.request)}`] : []),
  ];
}

export function formatChecksReport(check: AccessCheck | null): string[] {
  const summary = deployChecksSummary(check);
  const lines: string[] = [];
  if (check?.scope === 'partial' && check.selection) {
    const ran = (check.checked_parts ?? []).map(selectionLabel);
    lines.push('Partial smoke check requested for ' + selectionLabel(check.selection) + '.');
    lines.push(ran.length ? 'Checked ' + ran.join(', ') + '.' : 'No parts ran.');
  } else {
    lines.push('App smoke check');
  }
  if (!check || check.status === 'pending') {
    lines.push(`Could not check: the run did not finish within ${TEST_CHECKS_WAIT_MS / 1000} s.`);
  } else if (check.status !== 'checked') {
    lines.push(`Could not check: ${check.sentence ?? 'The check run is unavailable.'}`);
  } else {
    const checks = check.checks ?? [];
    for (const line of checks.filter((item) => lineOutcome(item) !== 'passed')) {
      const label = lineOutcome(line) === 'failed' ? 'FAIL' : 'Could not check';
      lines.push(`${label} ${line.name}`, ...resultEvidence(line));
      if (line.detail && line.responses?.length) lines.push(`  ${line.detail}`);
      if (!line.outcome && label === 'Could not check') lines.push(`  Run ${cliInvocation()} test --again to confirm this access check.`);
    }
    for (const line of checks.filter((item) => lineOutcome(item) === 'passed')) {
      const observation = line.responses?.[0]?.observed || line.detail || 'The stored result has no observation.';
      const label = check.not_checked ? line.name : `${line.method === 'flow' ? 'Browser flow' : line.method ?? 'Check'} ${line.path ?? '(surface unavailable)'}`;
      const status = line.status ? ` (HTTP ${line.status})` : '';
      lines.push(`PASS ${label}${status} — ${observation}`);
    }
    for (const finding of functionWarnings(check)) {
      if (finding.kind === 'crash') {
        lines.push(`Warning: A server function crashed: ${finding.via} (request ID ${finding.request_id}).`);
      } else {
        const receipt = [finding.status ? `HTTP ${finding.status}` : '', finding.request_id ? `request ID ${finding.request_id}` : ''].filter(Boolean).join(', ');
        lines.push(`Warning: ${finding.via} returned 5xx; no error record found yet${receipt ? ` (${receipt})` : ''}.`);
      }
    }
    for (const finding of cleanupFindings(check)) {
      const receipt = [finding.status ? `HTTP ${finding.status}` : '', finding.request_id ? `request ID ${finding.request_id}` : ''].filter(Boolean).join(', ');
      lines.push(`Could not check cleanup: ${finding.left_behind ?? (finding.table ? `A test row in ${finding.table} may remain.` : `Check whether any ${finding.via ?? 'test data'} remain.`)}${receipt ? ` (${receipt})` : ''}`);
    }
    if (!checks.length) lines.push('Could not check: no named checks ran.');
    if (check.scope !== 'partial' && summary.counts.could_not_check && !lines.some((line) => line.startsWith('Could not check'))) lines.push(`Could not check: run ${cliInvocation()} test --again to get named results.`);
  }
  const coverage = check?.not_checked ?? null;
  if (coverage) {
    if (typeof check?.routes_discovered === 'number') lines.push(`${check.routes_checked ?? 0} of ${check.routes_discovered} app routes had a completed read check.`);
    const { routes_without_read_check: reads, routes_without_write_check: writes, schedules_not_run: schedules, other } = coverage;
    if (reads === null || writes === null) lines.push('App route coverage could not be listed.');
    if (reads?.length) lines.push(`${reads.length} ${reads.length === 1 ? 'route' : 'routes'} without a read check (${reads.join(', ')}).`);
    if (writes?.length) lines.push(`${writes.length} ${writes.length === 1 ? 'route' : 'routes'} without a write check (${writes.join(', ')}).`);
    if (schedules === null) lines.push('Registered schedules could not be listed.');
    if (schedules?.length) lines.push(`${schedules.length} registered ${schedules.length === 1 ? 'schedule' : 'schedules'} did not run (${schedules.join(', ')}). Run one on your preview with ${cliInvocation()} cron run <name> --preview --wait.`);
    if (other.length) lines.push(`Other checks skipped or out of scope: ${other.join(', ')}.`);
  } else {
    lines.push('Coverage details are unavailable for this run.');
  }
  lines.push('For your own app tests, use @somewhere-cloud/cli/testing. See somewhere docs test.');
  return [...lines, JSON.stringify({
    ...summary, not_checked: coverage,
    ...(check?.scope === 'partial' ? { scope: check.scope, selection: check.selection, checked_parts: check.checked_parts } : {}),
    ...(coverage ? { routes_checked: check?.routes_checked, routes_discovered: check?.routes_discovered } : {}),
  })];
}

export function checksExitCode(check: AccessCheck | null): number {
  return checkSummaryExitCode(deployChecksSummary(check));
}
