import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_BASE_URL, type ApiClient } from './client.js';
import { CLI_VERSION } from './version.js';
import { projectFiles, type Inputs } from './test-ledger.js';

// Everything a kept test result depends on besides its own spec, gathered once per run (see
// test-ledger.ts). A part that cannot be read becomes a value that never matches, so nothing is kept.

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);
const unavailable = (): string => `unavailable ${randomUUID()}`;

/** The parts that can change on the platform without a new release: its version and the project's
 *  environment-variable listing (keys, scope, visibility, when set). An environment value replaced
 *  under the same key is not visible there; kept results expire after a while for that reason. */
export async function remoteInputs(client: ApiClient, projectId: string): Promise<{ platform: string; env: string }> {
  const [platform, env] = await Promise.all([
    fetch(API_BASE_URL.replace(/\/v1$/, '') + '/__version').then(async response => {
      if (!response.ok) return unavailable();
      const body = await response.json() as { cf_version_tag?: unknown; runtime_version?: unknown };
      return `${String(body.cf_version_tag)} ${String(body.runtime_version)}`;
    }).catch(unavailable),
    client.call<{ keys?: { key: string; scope?: string; visibility?: string; created_at?: string; browser_exposed?: boolean }[]; vars?: unknown[] }>('GET', '/env', undefined, { project_id: projectId })
      .then(result => sha(JSON.stringify((result.keys ?? (result.vars as typeof result.keys) ?? []).map(k => [k.key, k.scope, k.visibility, k.created_at, k.browser_exposed]).sort())))
      .catch(unavailable),
  ]);
  return { platform, env };
}

/** The somewhere CLI actually running the tests (not the project's installed copy): its version and its runner code. */
export function runnerIdentity(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter(name => /^(test-|playwright-fixtures|form-accounts|deploy-tests)/.test(name) && name.endsWith('.js')).sort();
  return `${CLI_VERSION} ${sha(files.map(name => name + readFileSync(join(dir, name), 'utf8')).join('\n'))}`;
}

export function collectInputs(input: { root: string; projectId: string; origin: string; release: string; remote: { platform: string; env: string }; browser: string; playwright: string }): Inputs {
  return {
    project: input.projectId, api: API_BASE_URL, origin: input.origin, release: input.release,
    platform: input.remote.platform, env: input.remote.env, runner: runnerIdentity(), browser: input.browser, playwright: input.playwright,
    ...projectFiles(input.root),
  };
}
