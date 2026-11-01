import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import prompts from 'prompts';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken } from '../lib/config.js';
import { dim, error, info, printJson, printJsonError, success, teal } from '../lib/output.js';

// `somewhere ai keys` — a project's own AI provider keys (bring your own key,
// tsk_c91717a5). Routes: worker/src/routes/ai-provider-keys.ts.
//   GET    /v1/ai/provider-keys?project_id=        → { project_id, keys: [{ provider, updated_at }] }
//   POST   /v1/ai/provider-keys { project_id, provider, key } → { project_id, provider, set: true }
//   DELETE /v1/ai/provider-keys/:project_id/:provider → { project_id, provider, deleted: true }
// The key is write-only. It is read from a hidden prompt or stdin, never from
// an argument, and no output, error or local record of this command holds it.

const PROVIDERS = ['anthropic', 'openai'] as const;
type Provider = (typeof PROVIDERS)[number];
const PROVIDER_NAMES: Record<Provider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

const KEY_MAX_LENGTH = 4096; // the route's own limit

const KEY_INPUT_NOTE =
  'The key is read from a hidden prompt, or from stdin with --stdin; it is never passed as an argument.';

interface ProviderKeyList {
  project_id?: string;
  keys?: Array<{ provider?: unknown; updated_at?: unknown }>;
}

/** Fail without naming the rejected value: it may be a key typed in the wrong place. */
function fail(message: string): never {
  error(message);
  process.exit(1);
}

function requireProvider(value: string): Provider {
  if ((PROVIDERS as readonly string[]).includes(value)) return value as Provider;
  fail(`The provider must be ${PROVIDERS.join(' or ')}.`);
}

/** The project is named on every call: a secret write never lands on a project inferred from the folder. */
function requireProject(value: string | undefined): string {
  const project = value?.trim();
  if (!project) fail('Pass --project <id>: the project whose AI provider keys this changes or lists.');
  return project;
}

async function readKey(stdin: boolean | undefined): Promise<string> {
  let raw: string;
  if (stdin) {
    if (process.stdin.isTTY) fail('Pipe the key into --stdin, or leave out --stdin to type it into a hidden prompt.');
    raw = readFileSync(0, 'utf8');
  } else {
    if (!process.stdin.isTTY) fail('Pass --stdin to read the key from a pipe. Nothing was sent.');
    // The prompt goes to stderr so --json keeps stdout to the result alone.
    const answer = await prompts({ type: 'password', name: 'key', message: 'API key', stdout: process.stderr });
    raw = typeof answer.key === 'string' ? answer.key : '';
  }
  // One final line ending is the pipe's, not the key's (as `env set --stdin`).
  const key = raw.replace(/\r?\n$/, '');
  if (!key.trim()) fail('No key was entered. Nothing was sent.');
  if (/\s/.test(key)) fail('The key contains spaces or line breaks; pass the key alone. Nothing was sent.');
  if (key.length > KEY_MAX_LENGTH) fail(`The key is longer than ${KEY_MAX_LENGTH} characters. Nothing was sent.`);
  return key;
}

function report(err: unknown): never {
  error(err instanceof Error ? err.message : String(err), err);
  process.exit(1);
}

// `keys` has its own action (the list) and subcommands, and both declare
// --project and --json; commander may hand either to the parent, so every
// action reads the merged options.
type KeyOptions = { project?: string; stdin?: boolean; json?: boolean };
const options = (cmd: Command) => cmd.optsWithGlobals<KeyOptions>();

/**
 * The status read (GET) ships with the platform after the set and remove
 * routes. Until then the platform answers 405 (only POST at that path) or a
 * bare "endpoint not found" 404. That is "status unknown", never "no keys":
 * an empty list would tell someone their key is gone when it is not.
 * PROJECT_NOT_FOUND and permission refusals carry their own codes and are
 * reported as they are.
 */
function statusUnavailable(project: string, json: boolean | undefined): never {
  const message =
    'Listing keys needs a newer platform, so which keys are set is not known here; set and remove work now ' +
    `(somewhere ai keys set anthropic --project ${project}).`;
  if (json) printJsonError('AI_KEY_STATUS_UNAVAILABLE', message);
  else error(message);
  process.exit(1);
}

function isMissingStatusRoute(err: unknown): boolean {
  return err instanceof CliApiError
    && ((err.statusCode === 405 && err.code === 'METHOD_NOT_ALLOWED') || (err.statusCode === 404 && err.code === 'NOT_FOUND'));
}

async function listKeys(_opts: unknown, cmd: Command) {
  const opts = options(cmd);
  const project = requireProject(opts.project);
  const client = new ApiClient(getToken());
  let result: ProviderKeyList;
  try {
    result = await client.call<ProviderKeyList>('GET', '/ai/provider-keys', undefined, { project_id: project });
  } catch (err) {
    if (isMissingStatusRoute(err)) statusUnavailable(project, opts.json);
    report(err);
  }
  if (!Array.isArray(result?.keys)) statusUnavailable(project, opts.json);
  if (opts.json) {
    printJson(result);
    return;
  }
  const keys = result.keys
    .filter((k): k is { provider: string; updated_at?: unknown } => typeof k?.provider === 'string');
  if (!keys.length) {
    info(dim('No AI provider keys set for this project.'));
    info(dim(`Set one with: somewhere ai keys set anthropic --project ${project}`));
    return;
  }
  for (const k of keys) {
    console.log(`  ${teal(k.provider)}  ${dim(typeof k.updated_at === 'string' ? `set ${k.updated_at}` : 'set')}`);
  }
}

export function registerAi(program: Command) {
  const ai = program
    .command('ai')
    .description('Manage AI settings for a project');

  const keys = ai
    .command('keys')
    .description("List, set or remove a project's own AI provider keys (the key itself is never shown)")
    .option('--project <id>', 'Project slug or ID (required)')
    .option('--json', 'Print the raw response as JSON')
    .allowExcessArguments(false)
    .action(listKeys);

  keys
    .command('list')
    .alias('ls')
    .description('List which providers have a key set, and when (never the key)')
    .option('--project <id>', 'Project slug or ID (required)')
    .option('--json', 'Print the raw response as JSON')
    .allowExcessArguments(false)
    .action(listKeys);

  keys
    .command('set <provider>')
    .description(`Save a provider key (${PROVIDERS.join(' or ')}) for sw.ai in a project. ${KEY_INPUT_NOTE}`)
    .option('--project <id>', 'Project slug or ID (required)')
    .option('--stdin', 'Read the key from stdin instead of a hidden prompt')
    .option('--json', 'Print the raw response as JSON')
    // Parsed here instead of by commander, whose refusal repeats the
    // offending text — and that text may be the key.
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (providerArg: string, _opts: unknown, cmd: Command) => {
      const opts = options(cmd);
      if (cmd.args.length !== 1) {
        fail(
          '`ai keys set` takes only the provider and its options. ' + KEY_INPUT_NOTE +
            ' If you typed the key on the command line, it may be in your shell history: replace that key with your provider.',
        );
      }
      const provider = requireProvider(providerArg);
      const project = requireProject(opts.project);
      const client = new ApiClient(getToken());
      const key = await readKey(opts.stdin);
      let result: { project_id?: string; provider?: string; set?: boolean };
      try {
        result = await client.call('POST', '/ai/provider-keys', { project_id: project, provider, key });
      } catch (err) {
        report(err);
      }
      if (opts.json) {
        printJson(result);
        return;
      }
      const name = PROVIDER_NAMES[provider];
      success(`${name} key saved for ${project}. sw.ai completions that name an ${name} model or provider use it from the next call; no redeploy is needed.`);
    });

  keys
    .command('remove <provider>')
    .alias('rm')
    .description('Remove a provider key from a project')
    .option('--project <id>', 'Project slug or ID (required)')
    .option('--json', 'Print the raw response as JSON')
    .allowExcessArguments(false)
    .action(async (providerArg: string, _opts: unknown, cmd: Command) => {
      const opts = options(cmd);
      const provider = requireProvider(providerArg);
      const project = requireProject(opts.project);
      const client = new ApiClient(getToken());
      let result: { project_id?: string; provider?: string; deleted?: boolean };
      try {
        result = await client.call(
          'DELETE',
          `/ai/provider-keys/${encodeURIComponent(project)}/${encodeURIComponent(provider)}`,
        );
      } catch (err) {
        if (!opts.json && err instanceof CliApiError && err.statusCode === 404 && err.code === 'NOT_FOUND') {
          error(`No ${PROVIDER_NAMES[provider]} key was set for ${project}.`, err);
          process.exit(1);
        }
        report(err);
      }
      if (opts.json) {
        printJson(result);
        return;
      }
      success(`${PROVIDER_NAMES[provider]} key removed for ${project}.`);
    });
}
