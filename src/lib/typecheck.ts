/**
 * The "is this safe to deploy?" gate: run `tsc --noEmit` over a pulled tree
 * and surface file:line errors — especially TS2304 ("X is not defined"), the
 * dropped-import class that 500s production when nothing typechecks it.
 *
 * tsc resolution order (first that exists wins):
 *   1. the project's own node_modules/.bin/tsc (if they ran `npm install`)
 *   2. the CLI checkout's TypeScript during development/tests (a devDependency)
 *   3. `npx -y typescript` as a last resort
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCAFFOLD_TSCONFIG_FILENAME } from './scaffold.js';
import { TYPECHECK_TYPESCRIPT_VERSION } from './typecheck-version.js';
import { prepareDeclaredData, type LocalDeclaredData } from './declared-data.js';

export interface TypeError {
  file: string;
  line: number;
  column: number;
  code: string; // e.g. "TS2304"
  message: string;
}

/**
 * Diagnostics about bare npm imports that can't be resolved LOCALLY but resolve
 * fine on deploy (esm.sh pins them from package.json). Reporting them would
 * drown the real "undefined symbol" signal and falsely fail clean code, so they
 * are dropped from the verdict:
 *   TS2307  Cannot find module 'X' or its corresponding type declarations
 *   TS7016  Could not find a declaration file for module 'X' (implicit any)
 *   TS2306  File is not a module
 *   TS2875  JSX runtime package can't be resolved locally
 * This is intentional and bounded: TS2304 (undefined name — the dropped-import
 * bug we're chasing) is NOT in this set and is always reported.
 */
const UNRESOLVED_DEP_CODES = new Set(['TS2307', 'TS7016', 'TS2306', 'TS2875']);

export interface TypecheckResult {
  /** true = no type errors. */
  ok: boolean;
  errors: TypeError[];
  /** How tsc was located, for a one-line "ran via …" note. */
  via: 'project' | 'bundled' | 'npx';
  /** Raw combined stdout+stderr — shown when we couldn't parse structured errors. */
  raw: string;
  /** Set when tsc itself couldn't be run at all. */
  spawnError?: string;
}

interface TscInvocation {
  command: string;
  args: string[];
  via: TypecheckResult['via'];
}

export function npxTscInvocation(
  platform: NodeJS.Platform = process.platform,
): TscInvocation {
  return {
    command: platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', '-p', `typescript@${TYPECHECK_TYPESCRIPT_VERSION}`, 'tsc'],
    via: 'npx',
  };
}

/**
 * Load the pulled tree's project config explicitly. TypeScript 7 reports
 * TS5112 when source files are passed because that would ignore tsconfig.json;
 * this project-wide invocation needs neither source-file args nor
 * --ignoreConfig.
 */
export function typecheckArgs(prefixArgs: readonly string[] = []): string[] {
  return [
    ...prefixArgs,
    '--project',
    SCAFFOLD_TSCONFIG_FILENAME,
    '--noEmit',
    '--pretty',
    'false',
  ];
}

/** Locate a runnable tsc. Never throws — npx is the always-available fallback. */
function resolveTsc(projectDir: string): TscInvocation {
  const projectBin = join(
    projectDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  if (existsSync(projectBin)) {
    return { command: projectBin, args: [], via: 'project' };
  }

  // TypeScript is a CLI devDependency, so this resolves in a source checkout
  // and tests. Published installs omit devDependencies and use the pinned npx
  // fallback below unless the project has its own compiler.
  try {
    const require = createRequire(import.meta.url);
    // typescript ships bin/tsc (a Node script). Resolve its package dir.
    const tscBin = require.resolve('typescript/bin/tsc');
    if (existsSync(tscBin)) {
      return { command: process.execPath, args: [tscBin], via: 'bundled' };
    }
  } catch {
    // not resolvable from here — fall through to npx
  }

  return npxTscInvocation();
}

/**
 * A type package declared in package.json but absent from node_modules is not a
 * mistake in the code — it is a tree that has not been installed yet. tsc has no
 * way to tell those apart, so the first check on a fresh pull failed with
 * TS2503 ("Cannot find namespace 'JSX'") and every agent lost a couple of
 * minutes installing by hand before re-running. Resolving the DECLARED packages
 * first makes the first check mean what it says.
 *
 * Deliberately narrow, so this can never mask a real bug:
 *   - only `@types/*` entries, only ones the project itself declares, only ones
 *     actually missing from node_modules. An UNDECLARED import still fails with
 *     its real diagnostic — that is the bug the gate exists to catch.
 *   - a warm tree plans nothing and spawns nothing.
 * Mirrors the prerequisite the platform's deploy-check container already
 * provides for the same tree.
 */
export interface DeclaredTypesPlan {
  /** Install specs (`@types/react@^18.3.0`) for declared-but-missing packages. */
  specs: string[];
  /** Bare package names, for messaging. */
  missing: string[];
}

export type TypePackageInstaller = (specs: string[], projectDir: string) => void;

export function planDeclaredTypePackages(projectDir: string): DeclaredTypesPlan {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
  } catch {
    return { specs: [], missing: [] }; // no manifest, nothing declared
  }
  if (!manifest || typeof manifest !== 'object') return { specs: [], missing: [] };
  const record = manifest as Record<string, unknown>;
  const declared: Record<string, string> = {};
  for (const field of ['dependencies', 'devDependencies']) {
    const group = record[field];
    if (!group || typeof group !== 'object') continue;
    for (const [name, range] of Object.entries(group as Record<string, unknown>)) {
      if (name.startsWith('@types/') && typeof range === 'string' && range) declared[name] = range;
    }
  }

  const specs: string[] = [];
  const missing: string[] = [];
  for (const [name, range] of Object.entries(declared)) {
    if (existsSync(join(projectDir, 'node_modules', ...name.split('/')))) continue;
    missing.push(name);
    // `name@range` is npm's spec form for a semver range, a file:/link: path,
    // and a git/URL range alike, so one shape covers every declaration.
    specs.push(`${name}@${range}`);
  }
  return { specs, missing };
}

/**
 * Resolve declared-but-missing type packages with a caller-supplied installer.
 * The CLI's own commands never install into a project (tsk_97979518,
 * pfb_8f0f7cdd04a1): they refuse with missingTypePackagesMessage instead.
 * Fail-open: an installer that throws never blocks the check.
 */
export function ensureDeclaredTypePackages(
  projectDir: string,
  install: TypePackageInstaller,
): DeclaredTypesPlan & { installed: boolean } {
  const plan = planDeclaredTypePackages(projectDir);
  if (plan.specs.length === 0) return { ...plan, installed: false };
  try {
    install(plan.specs, projectDir);
    return { ...plan, installed: true };
  } catch {
    return { ...plan, installed: false };
  }
}

/** Why a check did not run: declared type packages are not installed. The
 *  typecheck never installs them itself (it would change the project tree and
 *  run package scripts). */
export function missingTypePackagesMessage(missing: string[], projectDir: string): string {
  return `Not checked: this project's declared type packages are not installed (${missing.join(', ')}). `
    + `somewhere typecheck does not install the project's dependencies. Install them (npm install in ${projectDir}), then run it again.`;
}

/** Longest a typecheck child may run before it and its children are stopped.
 *  SOMEWHERE_TYPECHECK_TIMEOUT_MS overrides it. */
export function typecheckTimeoutMs(): number {
  const parsed = Number(process.env.SOMEWHERE_TYPECHECK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 300_000;
}

export interface BoundedResult { code: number | null; out: string; stdout: string; error?: Error; timedOut: boolean }

/** How long a stopped child tree gets after TERM before KILL, and after KILL
 *  before the run is reported. */
const STOP_GRACE_MS = 2_000;

/**
 * Run a typecheck child (tsc, or npx fetching it) with a deadline.
 *
 * POSIX: the child leads its own process group. A timeout, Ctrl-C or TERM
 * sends TERM to the whole group, waits for it to empty, sends KILL to whatever
 * ignored TERM, and waits again, so no descendant outlives the command. A
 * group is only signalled while it still has members, and no timer survives
 * the run, so a recycled PID or group is never signalled later.
 * Windows: the tree is stopped with `taskkill /T /F` (not exercised by this
 * CLI's tests). `onAbort` runs before the CLI exits on Ctrl-C/TERM, for the
 * caller's temporary files.
 */
export function runBounded(
  command: string,
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; onAbort?: () => void } = {},
): Promise<BoundedResult> {
  const timeoutMs = options.timeoutMs ?? typecheckTimeoutMs();
  return new Promise((resolve) => {
    const posixGroup = process.platform !== 'win32';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: posixGroup,
        // Windows: tsc.cmd / npx.cmd are batch shims, and since Node 18.20/20.12
        // (CVE-2024-27980) spawning a .cmd/.bat without a shell throws EINVAL.
        // The bundled path runs node directly (process.execPath) and must NOT
        // shell — its arg is a resolved file path that a shell could mis-split.
        shell: /\.(cmd|bat)$/i.test(command),
      });
    } catch (err) {
      resolve({ code: null, out: '', stdout: '', error: err instanceof Error ? err : new Error(String(err)), timedOut: false });
      return;
    }
    let out = '', stdout = '', timedOut = false, closed = false, settled = false, aborting = false, stopping: Promise<void> | null = null;
    let closeCode: number | null = null, spawnError: Error | undefined;
    const pid = child.pid;
    const treeAlive = (): boolean => {
      if (!pid) return false;
      if (!posixGroup) return !closed;
      try { process.kill(-pid, 0); return true; }
      catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
    };
    const signalTree = (signal: NodeJS.Signals) => {
      if (!pid || !treeAlive()) return;
      if (posixGroup) {
        try { process.kill(-pid, signal); } catch { /* emptied meanwhile */ }
      } else {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      }
    };
    const waitEmpty = async (ms: number): Promise<boolean> => {
      const until = Date.now() + ms;
      while (treeAlive() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      return !treeAlive();
    };
    const stopTree = (): Promise<void> => {
      stopping ??= (async () => {
        signalTree('SIGTERM');
        if (await waitEmpty(STOP_GRACE_MS)) return;
        signalTree('SIGKILL');
        await waitEmpty(STOP_GRACE_MS);
      })();
      return stopping;
    };
    const finish = () => {
      // An interrupted run never reports: the CLI exits from onSignal once the
      // tree is stopped and temporary files are removed.
      if (settled || aborting) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve({ code: closeCode, out, stdout, timedOut, ...(spawnError ? { error: spawnError } : {}) });
    };
    const onSignal = (exitCode: number) => {
      if (aborting) return;
      aborting = true;
      clearTimeout(timer);
      void stopTree().then(() => {
        try { options.onAbort?.(); } finally { process.exit(exitCode); }
      });
    };
    const onInt = () => onSignal(130);
    const onTerm = () => onSignal(143);
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const timer = setTimeout(() => {
      timedOut = true;
      void stopTree().then(async () => {
        // A descendant holding the output pipes can delay 'close'; the tree is
        // gone, so report after a bounded wait either way.
        const until = Date.now() + STOP_GRACE_MS;
        while (!closed && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
        finish();
      });
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (error: Error) => { spawnError = error; closed = true; if (!timedOut) finish(); });
    child.on('close', (code: number | null) => {
      closed = true;
      closeCode = code;
      // A timed-out run reports once its tree is stopped (above).
      if (!timedOut) finish();
    });
  });
}

export function timedOutMessage(via: TscInvocation['via']): string {
  const seconds = Math.round(typecheckTimeoutMs() / 1000);
  return `The typecheck did not finish within ${seconds}s and was stopped${via === 'npx' ? ' (fetching TypeScript with npx needs the npm registry)' : ''}. `
    + 'Set SOMEWHERE_TYPECHECK_TIMEOUT_MS to allow longer.';
}

/**
 * Parse tsc's default (non-pretty) diagnostic lines:
 *   path/to/file.ts(12,5): error TS2304: Cannot find name 'sanitizeForSpeech'.
 */
export function parseTscOutput(output: string): TypeError[] {
  const errors: TypeError[] = [];
  const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
  for (const line of output.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (!m) continue;
    errors.push({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      code: m[4],
      message: m[5],
    });
  }
  return errors;
}

/**
 * Run a typecheck against `projectDir`. Assumes a tsconfig.json is present
 * (pull scaffolds one); without it, tsc errors loudly and we surface that.
 */
export function runTypecheck(
  projectDir: string,
  options: { installTypePackages?: TypePackageInstaller | false } = {},
): Promise<TypecheckResult> {
  let declaredData: LocalDeclaredData | undefined;
  try { declaredData = prepareDeclaredData(projectDir); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve({ ok: false, errors: [{ file: 'db/schema.ts', line: 1, column: 1, code: 'SCHEMA_DECLARATION_INVALID', message }], via: 'bundled', raw: message });
  }
  // Only a caller-supplied installer resolves declared type packages; the
  // default never installs into the project.
  if (options.installTypePackages) {
    ensureDeclaredTypePackages(projectDir, options.installTypePackages);
  }
  const { command, args, via } = resolveTsc(projectDir);
  return runTypecheckWith(projectDir, command, args, via, declaredData);
}

/** Announce, on stderr so JSON on stdout is untouched, that TypeScript is
 *  about to be fetched with npx: a network step that also writes npm's cache.
 *  The project's own dependencies are never installed. */
export function announceNpxTypeScriptFetch(version: string): void {
  process.stderr.write(`TypeScript is not installed in this project; fetching typescript@${version} with npx (needs the npm registry; npm keeps it in its cache). The project's dependencies are not installed.\n`);
}

/** How this project's typecheck will get its compiler: 'npx' means a
 *  network fetch of TypeScript, which commands announce before running. */
export function typecheckCompilerSource(projectDir: string): TscInvocation['via'] {
  return resolveTsc(projectDir).via;
}

async function runTypecheckWith(
  projectDir: string,
  command: string,
  args: string[],
  via: TscInvocation['via'],
  declaredData: LocalDeclaredData | undefined,
): Promise<TypecheckResult> {
  // --pretty false → stable, parseable one-line diagnostics regardless of TTY.
  const fullArgs = typecheckArgs(args);
  let overlay: string | undefined;
  if (declaredData) {
    // TypeScript resolves JSONC, inherited configs and explicit files itself.
    // Preserve that complete file set, adding only our declaration and schema.
    const config = await runBounded(command, [...args, '--project', SCAFFOLD_TSCONFIG_FILENAME, '--showConfig'], projectDir);
    if (config.timedOut) return { ok: false, errors: [], via, raw: config.out, spawnError: timedOutMessage(via) };
    if (config.error || config.code !== 0) {
      return { ok: false, errors: [], via, raw: config.out,
        ...(config.error ? { spawnError: config.error.message } : {}) };
    }
    try {
      const parsed = JSON.parse(config.stdout) as { files?: unknown };
      if (!Array.isArray(parsed.files) || !parsed.files.every((file): file is string => typeof file === 'string')) {
        throw new Error('TypeScript did not return the project file list.');
      }
      overlay = join(projectDir, `.__somewhere_typecheck_${randomUUID()}.json`);
      writeFileSync(overlay, JSON.stringify({
        extends: './' + SCAFFOLD_TSCONFIG_FILENAME,
        files: [...new Set([
          ...parsed.files,
          relative(projectDir, declaredData.declarationPath),
          ...(declaredData.filesDeclarationPath ? [relative(projectDir, declaredData.filesDeclarationPath)] : []),
          ...(declaredData.schemaPath ? [relative(projectDir, declaredData.schemaPath)] : []),
        ])],
        include: [], exclude: [],
      }));
      fullArgs[args.length + 1] = relative(projectDir, overlay);
    } catch (error) {
      if (overlay) rmSync(overlay, { force: true });
      return { ok: false, errors: [], via, raw: error instanceof Error ? error.message : String(error) };
    }
  }
  const cleanup = () => { if (overlay) rmSync(overlay, { force: true }); };

  const run = await runBounded(command, fullArgs, projectDir, { onAbort: cleanup });
  cleanup();
  if (run.timedOut) return { ok: false, errors: [], via, raw: run.out, spawnError: timedOutMessage(via) };
  if (run.error) return { ok: false, errors: [], via, raw: run.out, spawnError: run.error.message };
  const allErrors = parseTscOutput(run.out);
  // Drop locally-unresolvable bare-import diagnostics (they resolve on
  // deploy via esm.sh) so they don't bury the real bugs. Undefined symbols
  // (TS2304) survive the filter.
  const errors = allErrors.filter((e) => !UNRESOLVED_DEP_CODES.has(e.code)
    || /['"]somewhere(?::data|:files|\/db)['"]/.test(e.message));
  // tsc exits non-zero whenever it emits diagnostics. If it failed but we
  // parsed NONE (a config/crash failure, not type errors), don't claim
  // "clean" — surface it via raw output so the user sees something's wrong.
  const unexplainedFailure = run.code !== 0 && allErrors.length === 0;
  return { ok: errors.length === 0 && !unexplainedFailure, errors, via, raw: run.out };
}

/** Where this module lives — used by tests that need the CLI package root. */
export function cliPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}
