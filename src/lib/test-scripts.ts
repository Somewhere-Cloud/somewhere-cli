import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { describeReport, TEST_COMMAND, type ReportCheck } from './test-report.js';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { testDependencyError, testImportEnv } from './test-run.js';
import { cliConfigDir } from './config.js';

// `somewhere test <file>` (and --failed) for a project with no tests/**/*.spec.ts: run each named tests/*.mjs or
// tests/*.cjs script (an ordinary Playwright script) with node, one at a time, with the
// project's Playwright and a browser it can launch, and report each script's result. A script is its own test:
// its exit code is the verdict.

export interface ScriptResult { script: string; ok: boolean; exitCode: number; ms: number; reason: string | null; checks?: ReportCheck[]; resultFile?: string | null; browserCrashed?: boolean }

/** Chromium's own words when it cannot read its files (seen on macOS when the volume it is on is refused). */
const BROWSER_CRASH = /icudtl\.dat not found|GPU process isn't usable/;
export const BROWSER_CRASH_REASON = 'the browser could not read its own files ("icudtl.dat not found", "GPU process isn\'t usable") and closed. '
  + 'On macOS this is the disk-access permission for the volume it is on: give the app that runs this command access to removable volumes '
  + '(System Settings > Privacy & Security > Files and Folders), or start it as node node_modules/@somewhere-cloud/cli/bin/somewhere.js test.';

/** Whether the project has any Playwright spec under tests/. */
export function hasSpecFiles(root: string): boolean {
  const walk = (dir: string): boolean => {
    if (!existsSync(dir)) return false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory() ? walk(path) : /\.spec\.ts$/.test(entry.name)) return true;
    }
    return false;
  };
  return walk(join(root, 'tests'));
}

export const isScript = (file: string): boolean => /\.[cm]js$/.test(file);

/** The scripts to run: the named ones, or every tests/*.mjs and tests/*.cjs, in name order. */
export function listScripts(root: string, files: string[]): string[] {
  if (files.length) return files.map((file) => relative(root, resolve(root, file)));
  const dir = join(root, 'tests');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => isScript(name) && statSync(join(dir, name)).isFile()).sort().map((name) => join('tests', name));
}

/** Playwright's own Chromium, which a script's plain chromium.launch() needs: used where it already is, otherwise
 *  installed once into the CLI cache. Returns the environment the scripts run with. */
function scriptBrowserEnv(root: string): NodeJS.ProcessEnv {
  const require = createRequire(join(root, 'package.json'));
  let cli: string;
  try { cli = require.resolve('@playwright/test/cli'); }
  catch { throw testDependencyError(root); }
  const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_NO_COPY_PROMPT: '1' };
  const probe = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).chromium.launch().then(b => b.close()).then(() => process.exit(0), () => process.exit(3))', require.resolve('@playwright/test')], { env, stdio: 'ignore' });
  if (probe.status === 0) return env;
  env.PLAYWRIGHT_BROWSERS_PATH ??= join(cliConfigDir(), 'cache', 'playwright');
  process.stderr.write('Installing Playwright Chromium in the CLI cache (once).\n');
  const install = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit', env });
  if (install.status !== 0) throw new Error('Playwright Chromium installation failed');
  return env;
}

/** The line that says why a script failed: its first "FAIL ..." line, else its first error header, else the last line. */
export function failureReason(output: string): string | null {
  // A browser that could not read its own files says so in its own log lines; name that, not the error it caused later.
  if (BROWSER_CRASH.test(output)) return BROWSER_CRASH_REASON;
  // Node's own frames (a source line, its ^ marker, stack lines, the version footer, warnings) never name the reason.
  const frame = (line: string) => /^\s*\^+\s*$|^\s+at |^Node\.js v\d|node:internal|triggerUncaughtException|^\s*throw |^\(Use `node --trace-|^\s*Warning: |^Warning: /.test(line)
    || /^file:\/\/\S+:\d+$/.test(line.trim());
  const lines = output.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() && !frame(line));
  const fail = lines.find((line) => /^(FAIL\b|✗|not ok\b)/.test(line.trimStart()));
  if (fail) return fail.trim().replace(/^(FAIL\b|✗|not ok\b)\s*/, '');
  const detail = lines.filter((line) => !/^\s*(?:hint:|Usage details:|Platform bug reports:)/i.test(line));
  const error = detail.find((line) => /^\s*(?:[\w.]*Error|[\w.]*Exception)(?: \[[^\]]+\])?:/.test(line))
    ?? detail.find((line) => /(?:assert|Timeout|refused|ECONN|closed)/i.test(line));
  return (error ?? detail.at(-1) ?? null)?.trim().slice(0, 300) ?? null;
}

/** Run each script once, streaming its output, and return one result per script. */
export async function runScripts(root: string, scripts: string[], extraArgs: string[], env: NodeJS.ProcessEnv = scriptBrowserEnv(root)): Promise<ScriptResult[]> {
  env = testImportEnv(root, env);
  const results: ScriptResult[] = [];
  for (const script of scripts) {
    if (!existsSync(join(root, script))) { results.push({ script, ok: false, exitCode: 1, ms: 0, reason: 'no such file' }); continue; }
    process.stdout.write(`\n▶ ${script}\n`);
    const started = performance.now();
    let output = '';
    // A script using openAppTest hands its checks over here instead of printing its own summary.
    const handOver = join(root, '.somewhere', 'tests', `report-${results.length}.json`);
    mkdirSync(dirname(handOver), { recursive: true });
    rmSync(handOver, { force: true });
    // Playwright writes the browser's own log only under DEBUG=pw:browser. It is turned on so a browser that
    // dies can be named, and kept off the screen unless the person asked for it themselves.
    const askedForBrowserLog = /(^|,)\s*(pw:browser|pw:\*|\*)\s*(,|$)/.test(env.DEBUG ?? '');
    const childEnv = { ...env, SW_TEST_REPORT: handOver, DEBUG: askedForBrowserLog ? env.DEBUG : [env.DEBUG, 'pw:browser'].filter(Boolean).join(',') };
    const child = spawn(process.execPath, [script, ...extraArgs], { cwd: root, env: childEnv, stdio: ['inherit', 'pipe', 'pipe'] });
    let browserCrashed = false;
    const keep = (chunk: Buffer, to: NodeJS.WriteStream) => { to.write(chunk); output = (output + chunk.toString('utf8')).slice(-20_000); };
    let partial = '';
    const stderrLines = (text: string, flush = false) => {
      const lines = (partial + text).split('\n');
      partial = flush ? '' : lines.pop() ?? '';
      for (const line of lines) {
        if (BROWSER_CRASH.test(line)) browserCrashed = true;
        if (!askedForBrowserLog && /\bpw:browser\b/.test(line)) continue;
        keep(Buffer.from(line + '\n'), process.stderr);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => keep(chunk, process.stdout));
    child.stderr.on('data', (chunk: Buffer) => stderrLines(chunk.toString('utf8')));
    const exitCode = await new Promise<number>((done) => child.on('close', (code) => done(code ?? 1)));
    if (partial) stderrLines('', true);
    let report: { checks?: ReportCheck[]; resultFile?: string } | null = null;
    try { report = existsSync(handOver) ? JSON.parse(readFileSync(handOver, 'utf8')) : null; } catch { report = null; }
    rmSync(handOver, { force: true });
    results.push({ script, ok: exitCode === 0, exitCode, ms: Math.round(performance.now() - started),
      reason: exitCode === 0 ? null : browserCrashed ? BROWSER_CRASH_REASON : failureReason(output),
      checks: report?.checks, resultFile: report?.resultFile ?? null, ...(browserCrashed ? { browserCrashed } : {}) });
  }
  return results;
}

/** The result for the whole run: every check that ran, failures first, one line each, then one summary line.
 *  A script that reports no checks (an ordinary script without openAppTest) counts as one check named by its file. */
export function describeScriptResults(results: ScriptResult[], options: { verbose?: boolean } = {}): string[] {
  if (!results.length) return [`No tests found: add a Playwright script as tests/<name>.mjs or .cjs, then run it with ${TEST_COMMAND} tests/<name>.mjs.`];
  const lines = describeReport(results.map((result) => {
    const checks = result.checks ?? [{ name: result.script, ok: result.ok, ...(result.ok ? {} : { error: result.reason ?? `exit ${result.exitCode}` }) }];
    // A script that failed after reporting only passes (it crashed after finish) still fails, by its own name;
    // so does one whose browser could not start, whatever its checks said.
    const crashed = !result.ok && (result.browserCrashed || !checks.some((check) => !check.ok));
    return { script: result.script, resultFile: result.resultFile ?? null,
      checks: crashed ? [{ name: result.script, ok: false, error: result.reason ?? `exit ${result.exitCode}` }, ...checks] : checks };
  }), options);
  // Nothing in the app needs a redeploy when the browser itself could not start.
  return results.some((result) => result.browserCrashed)
    ? lines.map((line) => (line.startsWith('Next: ') ? `Next: give the browser access as the FAIL line says, then run ${TEST_COMMAND} again.` : line))
    : lines;
}

const LAST = join('.somewhere', 'tests', 'scripts-last.json');

/** The scripts that failed in the last scripts run here, for --failed. */
export function lastFailedScripts(root: string): string[] {
  const path = join(root, LAST);
  if (!existsSync(path)) return [];
  try { return ((JSON.parse(readFileSync(path, 'utf8')) as { results?: ScriptResult[] }).results ?? []).filter((r) => !r.ok).map((r) => r.script); }
  catch { return []; }
}

export function recordScriptResults(root: string, results: ScriptResult[], rerunOnly: boolean): void {
  // A --failed run updates only the scripts it reran; every other script keeps its last result.
  const previous = rerunOnly && existsSync(join(root, LAST)) ? ((JSON.parse(readFileSync(join(root, LAST), 'utf8')) as { results?: ScriptResult[] }).results ?? []) : [];
  const merged = [...previous.filter((p) => !results.some((r) => r.script === p.script)), ...results];
  mkdirSync(join(root, '.somewhere', 'tests'), { recursive: true });
  writeFileSync(join(root, LAST), JSON.stringify({ finished: new Date().toISOString(), results: merged }, null, 2) + '\n');
}
