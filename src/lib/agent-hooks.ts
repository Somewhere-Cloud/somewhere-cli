/**
 * After-edit checking for coding agents: the deploy's reference check
 * (deploy-check.ts) run by the agent host after each file edit, and the
 * installer that adds that hook to a project's own host configuration.
 *
 * Host contracts (read from each host's documentation):
 * - Claude Code: `.claude/settings.json`, `PostToolUse`, regex matcher on the
 *   tool name; stdin JSON carries `tool_input.file_path`; exit 2 shows stderr
 *   to Claude after the tool ran; JSON `hookSpecificOutput.additionalContext`
 *   adds context without blocking.
 * - Codex: `.codex/hooks.json`, `PostToolUse`, matcher `Edit|Write` covers
 *   `apply_patch` (patch text in `tool_input.command`); exit 2 + stderr or
 *   `hookSpecificOutput.additionalContext` reaches the model. Project hooks run
 *   only after the user reviews and trusts them in Codex (`/hooks`).
 * - Cursor: `.cursor/hooks.json` (`version: 1`), `postToolUse`, edits report
 *   tool name `Write`; JSON `additional_context` reaches the agent. Project
 *   hooks run only in a trusted workspace.
 *
 * What is not caught: edits an agent makes through a shell command (Bash,
 * Shell) rather than its file-edit tools, and edits made outside the agent.
 * `somewhere typecheck --deploy --watch` covers those while it runs.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CLI_VERSION } from './version.js';
import type { DeployCheckResult } from './deploy-check.js';

export const AGENT_HOSTS = ['claude-code', 'codex', 'cursor'] as const;
export type AgentHost = (typeof AGENT_HOSTS)[number];

interface HostSpec {
  /** Project-relative config file. */
  configPath: string;
  event: string;
  matcher: string;
  /** What the user must still do in the host before the hook runs. */
  activation: string;
}

const HOSTS: Record<AgentHost, HostSpec> = {
  'claude-code': {
    configPath: join('.claude', 'settings.json'),
    event: 'PostToolUse',
    matcher: 'Edit|MultiEdit|Write|NotebookEdit',
    activation: 'Claude Code runs project hooks once the folder is trusted (the trust prompt when Claude Code opens it).',
  },
  codex: {
    configPath: join('.codex', 'hooks.json'),
    event: 'PostToolUse',
    matcher: 'Edit|Write',
    activation: 'Codex runs it only after you review and trust it: run /hooks in Codex in this project.',
  },
  cursor: {
    configPath: join('.cursor', 'hooks.json'),
    event: 'postToolUse',
    matcher: 'Write',
    activation: 'Cursor runs project hooks only in a trusted workspace.',
  },
};

/** Seconds the host waits for one check. The first check may fetch TypeScript. */
const HOOK_TIMEOUT_SECONDS = 300;

export function isAgentHost(value: string): value is AgentHost {
  return (AGENT_HOSTS as readonly string[]).includes(value);
}

// ── The installed command ─────────────────────────────────────────────────

/** The real path of the `somewhere` that PATH resolves to, if any. */
export function pathCli(pathEnv = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform): string | undefined {
  const names = platform === 'win32' ? ['somewhere.cmd', 'somewhere.exe', 'somewhere'] : ['somewhere'];
  for (const dir of pathEnv.split(delimiter)) {
    for (const file of names) {
      try {
        const candidate = join(dir, file);
        if (dir && statSync(candidate).isFile()) return realpathSync(candidate);
      } catch { /* not here */ }
    }
  }
  return undefined;
}

/** True when PATH's `somewhere` is this very CLI (not another installed version). */
export function pathCliIsThisCli(pathEnv = process.env.PATH, entry = process.argv[1]): boolean {
  const found = pathCli(pathEnv);
  if (!found || !entry) return false;
  try { return found === realpathSync(entry); } catch { return false; }
}

/**
 * The command a host runs after each edit. Plain `somewhere` only when PATH
 * resolves to this same CLI; otherwise (setup ran through npx, or PATH holds
 * another version that may lack the hook) this exact CLI version through npx,
 * preferring the npm cache so an edit does not re-download the CLI.
 */
export function agentHookCommand(host: AgentHost, options: { usePathCli?: boolean; version?: string } = {}): string {
  const cli = options.usePathCli ?? pathCliIsThisCli()
    ? 'somewhere'
    : `npx --yes --prefer-offline --package=@somewhere-tech/cli@${options.version ?? CLI_VERSION} somewhere`;
  return `${cli} typecheck --deploy --hook ${host}`;
}

const HOOK_MARKER = /\btypecheck --deploy --hook (claude-code|codex|cursor)\b/;

// ── Installation ──────────────────────────────────────────────────────────

export interface AgentHookInstallResult {
  host: AgentHost;
  /** Absolute config path written (or that would have been). */
  path: string;
  status: 'added' | 'updated' | 'unchanged' | 'refused';
  /** Why a host was refused (unreadable config). */
  reason?: string;
  /** The host's own activation step; the hook does not run before it. */
  activation: string;
}

type Json = Record<string, unknown>;

function readConfig(path: string): Json | Error {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : new Error('is not a JSON object');
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Why writing `path` would leave the project, or null when it would not:
 * every existing component from the project root down to `path` must resolve,
 * through any symlink, inside the project's real root. Components that do not
 * exist yet are created as plain directories under a contained parent.
 */
function escapesProject(projectDir: string, path: string): string | null {
  let current = projectDir;
  for (const part of relative(projectDir, path).split(sep)) {
    current = join(current, part);
    try { lstatSync(current); } catch { return null; }
    let real: string;
    try { real = realpathSync(current); } catch { return `${relative(projectDir, current)} is a broken link`; }
    if (real !== projectDir && !real.startsWith(projectDir + sep)) {
      return `${relative(projectDir, current)} resolves outside the project (${real})`;
    }
  }
  return null;
}

/** Why an existing config cannot take the check without being rewritten, or null. */
function incompatibleShape(host: AgentHost, config: Json, event: string): string | null {
  if (host === 'cursor' && config.version !== undefined && config.version !== 1) return `has version ${JSON.stringify(config.version)}, not 1`;
  if (config.hooks === undefined) return null;
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) return 'has "hooks" that is not an object';
  const entries = (config.hooks as Json)[event];
  if (entries !== undefined && !Array.isArray(entries)) return `has "hooks.${event}" that is not a list`;
  return null;
}

/** The check's existing handler for `host` under `entries`, if installed. */
function findHandler(entries: unknown[], host: AgentHost, nested: boolean): Json | undefined {
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const handlers = nested ? (entry as Json).hooks : [entry];
    if (!Array.isArray(handlers)) continue;
    for (const handler of handlers) {
      const command = handler && typeof handler === 'object' ? (handler as Json).command : undefined;
      const match = typeof command === 'string' ? HOOK_MARKER.exec(command) : null;
      if (match && match[1] === host) return handler as Json;
    }
  }
  return undefined;
}

/**
 * Add the after-edit check to the PROJECT's own configuration for each host,
 * merged into what is there: other hooks and settings are never replaced, and
 * an existing check entry is updated in place. Refuses the home directory,
 * any host config path that resolves (through symlinks) outside the project,
 * and existing settings whose shape would have to be rewritten to merge.
 *
 * Explicit installation only: call with the requested project root and hosts;
 * print `formatAgentHookInstall(...)`. Project initialization does not call it.
 */
export function installAgentHooks(options: {
  projectDir: string;
  hosts: readonly AgentHost[];
  command?: (host: AgentHost) => string;
}): AgentHookInstallResult[] {
  const projectDir = realpathSync(resolve(options.projectDir));
  if (projectDir === realpathSync(homedir())) {
    throw new Error('Refusing to install agent hooks in the home directory: that would change user-wide agent settings.');
  }
  const command = options.command ?? ((host: AgentHost) => agentHookCommand(host));
  return options.hosts.map((host) => {
    const spec = HOSTS[host];
    const path = join(projectDir, spec.configPath);
    const refuse = (why: string): AgentHookInstallResult =>
      ({ host, path, status: 'refused', reason: `${spec.configPath} ${why}; left unchanged`, activation: spec.activation });
    const escape = escapesProject(projectDir, path);
    if (escape) return refuse(`is not inside the project: ${escape}`);
    const config = readConfig(path);
    if (config instanceof Error) return refuse(config.message);
    const shape = incompatibleShape(host, config, spec.event);
    if (shape) return refuse(shape);
    const handler: Json = host === 'cursor'
      ? { command: command(host), matcher: spec.matcher, timeout: HOOK_TIMEOUT_SECONDS }
      : { type: 'command', command: command(host), timeout: HOOK_TIMEOUT_SECONDS };
    if (host === 'cursor' && config.version === undefined) config.version = 1;
    const hooks = (config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks) ? config.hooks : (config.hooks = {})) as Json;
    const entries = (Array.isArray(hooks[spec.event]) ? hooks[spec.event] : (hooks[spec.event] = [])) as unknown[];
    const existing = findHandler(entries, host, host !== 'cursor');
    let status: AgentHookInstallResult['status'];
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify({ ...existing, ...handler })) status = 'unchanged';
      else { Object.assign(existing, handler); status = 'updated'; }
    } else {
      entries.push(host === 'cursor' ? handler : { matcher: spec.matcher, hooks: [handler] });
      status = 'added';
    }
    if (status !== 'unchanged') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
    }
    return { host, path, status, activation: spec.activation };
  });
}

/** Human summary of an installation, one line per host plus its activation step. */
export function formatAgentHookInstall(results: readonly AgentHookInstallResult[], projectDir: string): string[] {
  const root = realpathSync(resolve(projectDir));
  return results.map((r) => {
    const where = relative(root, r.path);
    if (r.status === 'refused') return `${r.host}: not installed — ${r.reason}`;
    const what = r.status === 'unchanged' ? 'already checks edits' : r.status === 'added' ? 'now checks edits' : 'check updated';
    return `${r.host}: ${what} (${where}). ${r.activation}`;
  });
}

// ── The hook itself ───────────────────────────────────────────────────────

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']);
const SOURCE = /\.(?:tsx?|jsx?|mjs|cjs)$/i;

/**
 * Whether an edit to `relativePath` can change the deploy check's findings:
 * checked source (including db/schema.ts), the project's tsconfig, its
 * package manifest, or a lockfile (dependency edits change what resolves).
 */
export function affectsDeployCheck(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === 'node_modules' || segment === '..' || (segment.startsWith('.') && segment !== '.'))) return false;
  const name = segments[segments.length - 1];
  if (segments.length === 1 && (name === 'tsconfig.json' || name === 'package.json' || LOCKFILES.has(name))) return true;
  return SOURCE.test(name);
}

/** Paths the edit touched, as the host reports them; `null` when the event
 *  does not say (then the check runs anyway). */
export function editedPaths(host: AgentHost, payload: Json): string[] | null {
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input as Json : {};
  const direct = [input.file_path, input.notebook_path, input.path, input.target_file]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (direct.length) return direct;
  if (host === 'codex' && typeof input.command === 'string') {
    const paths = [...input.command.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)]
      .map((match) => (match[1] ?? match[2]).trim());
    if (paths.length) return paths;
  }
  return null;
}

/** The project the hook checks: the nearest directory at or above the host's
 *  start directory whose host config installs this check. Read-only. */
export function hookProjectRoot(host: AgentHost, payload: Json, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const start = [
    host === 'claude-code' ? env.CLAUDE_PROJECT_DIR : host === 'cursor' ? env.CURSOR_PROJECT_DIR : undefined,
    typeof payload.cwd === 'string' ? payload.cwd : undefined,
    cwd,
  ].find((dir): dir is string => typeof dir === 'string' && isAbsolute(dir) && existsSync(dir));
  if (!start) return null;
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const config = join(dir, HOSTS[host].configPath);
    if (existsSync(config) && HOOK_MARKER.test(readFileSync(config, 'utf8'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

export interface HookOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const MAX_LISTED = 20;

function findingsText(result: DeployCheckResult): string {
  const lines = result.findings.slice(0, MAX_LISTED)
    .map((f) => `${f.file}:${f.line}:${f.column} ${f.code} ${f.message}`);
  const more = result.findings.length > MAX_LISTED ? [`…and ${result.findings.length - MAX_LISTED} more (somewhere typecheck --deploy)`] : [];
  const n = result.findings.length;
  return [`Somewhere deploy check: ${n} finding${n === 1 ? '' : 's'} a deploy would report (undefined names fail at runtime):`, ...lines, ...more].join('\n');
}

function couldNotRunText(result: DeployCheckResult): string {
  const detail = (result.error ?? 'unknown error').split('\n').slice(0, 3).join(' | ');
  return `Somewhere deploy check could not run (TypeScript ${result.typescript}): ${detail}. Edits since then are unchecked; run \`somewhere typecheck --deploy\` to see the full error.`;
}

/** The host's envelope for "add this context" (not a failure). */
function contextEnvelope(host: AgentHost, text: string): HookOutcome {
  const body = host === 'cursor'
    ? { additional_context: text }
    : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } };
  return { exitCode: 0, stdout: JSON.stringify(body), stderr: '' };
}

/**
 * Handle one host event. Clean is silent; findings and a check that could
 * not run are always visible to the agent. Never deploys, never writes
 * project data, never calls a model.
 */
export async function runAgentHook(
  host: AgentHost,
  stdinText: string,
  deps: { check: (dir: string) => Promise<DeployCheckResult>; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<HookOutcome> {
  try {
    return await handleAgentHook(host, stdinText, deps);
  } catch (failure) {
    // An unexpected failure (unreadable settings, a check that threw) is
    // shown to the agent, never lost or mistaken for a clean check.
    const detail = failure instanceof Error ? failure.message : String(failure);
    return contextEnvelope(host, `Somewhere deploy check could not run: ${detail.split('\n')[0]}. Run \`somewhere typecheck --deploy\` to see more.`);
  }
}

async function handleAgentHook(
  host: AgentHost,
  stdinText: string,
  deps: { check: (dir: string) => Promise<DeployCheckResult>; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<HookOutcome> {
  const quiet: HookOutcome = { exitCode: 0, stdout: '', stderr: '' };
  let payload: Json;
  try {
    const parsed = JSON.parse(stdinText) as unknown;
    payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : {};
  } catch {
    payload = {};
  }
  const root = hookProjectRoot(host, payload, deps.env, deps.cwd);
  if (!root) return contextEnvelope(host, 'Somewhere deploy check could not run: no project with this check installed was found from the hook\'s directory.');
  const paths = editedPaths(host, payload);
  if (paths) {
    const relevant = paths.some((path) => {
      const rel = relative(root, isAbsolute(path) ? path : resolve(typeof payload.cwd === 'string' ? payload.cwd : root, path));
      return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) && affectsDeployCheck(rel);
    });
    if (!relevant) return quiet;
  }
  const result = await deps.check(root);
  if (result.error) return contextEnvelope(host, couldNotRunText(result));
  if (result.ok) return quiet;
  const text = findingsText(result);
  return host === 'cursor' ? contextEnvelope(host, text) : { exitCode: 2, stdout: '', stderr: text + '\n' };
}
