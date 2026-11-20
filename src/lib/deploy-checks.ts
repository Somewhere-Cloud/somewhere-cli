import { cliInvocation } from './cli-invocation.js';
import type { ApiClient } from './client.js';

/**
 * After a live deploy the platform runs its access check in the background and
 * answers the deploy with checks: { status: 'running', read: 'GET /v1/deploy/log?…' }.
 * The CLI reads that log every 3 s for up to 45 s and prints the check's
 * sentence. The result never changes the deploy's exit code.
 */
export interface AccessCheck {
  status: 'pending' | 'checked' | 'unavailable' | string;
  sentence: string | null;
  findings?: unknown[];
  checked_at?: string | null;
}

export interface DeployChecks {
  status?: string;
  read?: string;
}

export const DEPLOY_CHECKS_WAIT_MS = 45_000;
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
  const deadline = now() + (opts.waitMs ?? DEPLOY_CHECKS_WAIT_MS);
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

export const DEPLOY_CHECKS_STILL_RUNNING = `Checks: still running; \`${cliInvocation()} call project_deploy_log '{}'\` shows the result.`;

/** The line a deploy prints for its checks, or null when a settled check has no sentence. */
export function formatDeployChecksLine(check: AccessCheck | null): string | null {
  if (!check || check.status === 'pending') return DEPLOY_CHECKS_STILL_RUNNING;
  return check.sentence ? `Checks: ${check.sentence}` : null;
}
