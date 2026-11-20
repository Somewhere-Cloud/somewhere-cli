import { cliInvocation } from './cli-invocation.js';
import type { ApiClient } from './client.js';

/**
 * After a live deploy the platform runs its access check in the background and
 * answers the deploy with checks: { status: 'running', read: 'GET /v1/deploy/log?…' }.
 * A deploy never waits on it (it warns, never blocks; architect 2026-11-20): it prints one line saying the check is
 * running and how to read it. `somewhere test` reads the stored result, waiting only while that run is still going.
 */
export interface CheckLine { name: string; as?: string; method?: string; path?: string; status?: number; expected?: string; pass: boolean }

export interface AccessCheck {
  status: 'pending' | 'checked' | 'unavailable' | string;
  sentence: string | null;
  findings?: unknown[];
  checks?: CheckLine[];
  passed?: boolean;
  checked_at?: string | null;
}

export interface DeployChecks {
  status?: string;
  read?: string;
}

export const DEPLOY_CHECKS_POLL_MS = 3_000;

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
  opts: { waitMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<AccessCheck | null> {
  const target = typeof checks.read === 'string' ? parseChecksRead(checks.read) : null;
  if (!target) return null;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? DEPLOY_CHECKS_POLL_MS;
  const deadline = now() + (opts.waitMs ?? TEST_CHECKS_WAIT_MS);
  let last: AccessCheck | null = null;
  for (;;) {
    try {
      const read = await client.call<{ access_check?: AccessCheck | null }>('GET', target.path, undefined, target.query,
        { timeoutMs: Math.max(1000, deadline - now()) });
      if (read?.access_check) last = read.access_check;
      if (last && last.status !== 'pending') return last;
    } catch {
      // A failed read is retried until the deadline.
    }
    if (now() + pollMs > deadline) return last;
    await sleep(pollMs);
  }
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
  opts: Parameters<typeof awaitDeployChecks>[2] & { again?: boolean } = {},
): Promise<AccessCheck | null> {
  if (!opts.again) {
    const read = `GET /v1/deploy/log?project_id=${encodeURIComponent(projectId)}`;
    const stored = await awaitDeployChecks(client, { read }, { ...opts, waitMs: 0 });
    if (stored && stored.status !== 'pending') return stored;
    if (stored) return awaitDeployChecks(client, { read }, { waitMs: TEST_CHECKS_WAIT_MS, ...opts });
  }
  const started = await client.call<{ status?: string; version?: number; read?: string }>('POST', '/deploy/checks', { project_id: projectId });
  return awaitDeployChecks(client, { read: started?.read }, { waitMs: TEST_CHECKS_WAIT_MS, ...opts });
}

/** One PASS/FAIL line per check, failures first, then the sentence. */
export function formatChecksReport(check: AccessCheck | null): string[] {
  if (!check || check.status === 'pending') {
    return [`The checks did not finish within ${TEST_CHECKS_WAIT_MS / 1000} s; \`${cliInvocation()} call project_deploy_log '{}'\` shows the result when they do.`];
  }
  const lines = Array.isArray(check.checks) ? check.checks : [];
  return [
    ...lines.filter((line) => !line.pass).map((line) => `FAIL ${line.name}`),
    ...lines.filter((line) => line.pass).map((line) => `PASS ${line.name}`),
    ...(check.sentence ? [check.sentence] : []),
  ];
}

/** Exit 0 only for a finished record that passed. */
export function checksExitCode(check: AccessCheck | null): number {
  return check?.passed === true ? 0 : 1;
}
