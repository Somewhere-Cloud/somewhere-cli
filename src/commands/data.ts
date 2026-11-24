import type { Command } from 'commander';
import { classifyData } from '../lib/app-test.js';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { preparedActorSession } from '../lib/test-identities.js';
import { loadTestTarget } from '../lib/test-target.js';

function parseJson(text: string, flag: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error(`${flag} must be valid JSON`); }
}

export function registerData(program: Command): void {
  program.command('data <operation> <table>')
    .description('Probe a linked app as a signed-in user. Use --as for a prepared test user or set SOMEWHERE_APP_SESSION for an existing app session. Prints JSON with status, kind and data.')
    .option('--as <actor>', 'Use an actor saved by somewhere test-users prepare')
    .option('--id <value>', 'Row ID for get, update or delete')
    .option('--where <json>', 'Equality filters for list, as a JSON object')
    .option('--values <json>', 'Values for create or update, as a JSON object')
    .action(async (operation: string, table: string, opts: { as?: string; id?: string; where?: string; values?: string }) => {
      if (!['list', 'get', 'create', 'update', 'delete'].includes(operation)) {
        throw new Error('Use data list, get, create, update or delete.');
      }
      const input: Record<string, unknown> = { operation, table };
      if (opts.id !== undefined) input.id = opts.id;
      for (const key of ['where', 'values'] as const) {
        const value = opts[key];
        if (value !== undefined) input[key] = parseJson(value, `--${key}`);
      }
      if (!opts.as && !process.env.SOMEWHERE_APP_SESSION) {
        throw new Error('Pass --as with a prepared test user or set SOMEWHERE_APP_SESSION to an app session token.');
      }
      const projectId = loadProjectConfig()?.project_id;
      if (!projectId) throw new Error('Run somewhere data from a linked project folder.');
      const target = await loadTestTarget(new ApiClient(getToken()), projectId);
      const origin = new URL(target.origin);
      if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
        throw new Error('The linked app needs an HTTPS address.');
      }
      const session = opts.as ? preparedActorSession(process.cwd(), target, opts.as) : process.env.SOMEWHERE_APP_SESSION;
      if (!session || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(session)) {
        throw new Error('Supply a valid app session token.');
      }
      const response = await fetch(new URL('/__sw/data', origin), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', Origin: origin.origin, Authorization: `Bearer ${session}` },
        body: JSON.stringify({ ...input, contract: target.contractDigest ?? '' }),
      });
      const body: unknown = await response.json().catch(() => null);
      const result = classifyData(response.status, body, operation);
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exitCode = result.kind === 'ok' || result.kind === 'empty' ? 0 : 1;
    });
}
