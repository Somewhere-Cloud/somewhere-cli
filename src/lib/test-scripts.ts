import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { cliConfigDir } from './config.js';

// `somewhere test` for a project with no tests/**/*.spec.ts: run each tests/*.mjs and tests/*.cjs script (an
// ordinary Playwright script, such as the starter's tests/app-check.mjs) with node, one at a time, with the
// project's Playwright and a browser it can launch, and report each script's result. A script is its own test:
// its exit code is the verdict.

export interface ScriptResult { script: string; ok: boolean; exitCode: number; ms: number; reason: string | null }

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
  catch { throw new Error('Install project test dependencies: npm install -D @playwright/test @somewhere-cloud/cli'); }
  const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_NO_COPY_PROMPT: '1' };
  const probe = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).chromium.launch().then(b => b.close()).then(() => process.exit(0), () => process.exit(3))', require.resolve('@playwright/test')], { env, stdio: 'ignore' });
  if (probe.status === 0) return env;
  env.PLAYWRIGHT_BROWSERS_PATH ??= join(cliConfigDir(), 'cache', 'playwright');
  process.stderr.write('Installing Playwright Chromium in the CLI cache (once).\n');
  const install = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit', env });
  if (install.status !== 0) throw new Error('Playwright Chromium installation failed');
  return env;
}

/** The line that says why a script failed: its first "FAIL ..." line, else its last error line, else the last line. */
export function failureReason(output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const fail = lines.find((line) => /^(FAIL\b|✗|not ok\b)/.test(line.trimStart()));
  if (fail) return fail.trim().replace(/^(FAIL\b|✗|not ok\b)\s*/, '');
  const error = [...lines].reverse().find((line) => /(Error|assert|Timeout|refused|ECONN)/i.test(line));
  return (error ?? lines.at(-1) ?? null)?.trim().slice(0, 300) ?? null;
}

/** Run each script once, streaming its output, and return one result per script. */
export async function runScripts(root: string, scripts: string[], extraArgs: string[], env: NodeJS.ProcessEnv = scriptBrowserEnv(root)): Promise<ScriptResult[]> {
  const results: ScriptResult[] = [];
  for (const script of scripts) {
    if (!existsSync(join(root, script))) { results.push({ script, ok: false, exitCode: 1, ms: 0, reason: 'no such file' }); continue; }
    process.stdout.write(`\n▶ ${script}\n`);
    const started = performance.now();
    let output = '';
    const child = spawn(process.execPath, [script, ...extraArgs], { cwd: root, env, stdio: ['inherit', 'pipe', 'pipe'] });
    const keep = (chunk: Buffer, to: NodeJS.WriteStream) => { to.write(chunk); output = (output + chunk.toString('utf8')).slice(-20_000); };
    child.stdout.on('data', (chunk: Buffer) => keep(chunk, process.stdout));
    child.stderr.on('data', (chunk: Buffer) => keep(chunk, process.stderr));
    const exitCode = await new Promise<number>((done) => child.on('close', (code) => done(code ?? 1)));
    results.push({ script, ok: exitCode === 0, exitCode, ms: Math.round(performance.now() - started), reason: exitCode === 0 ? null : failureReason(output) });
  }
  return results;
}

/** The summary: failures first, one line each, then what to do next. */
export function describeScriptResults(results: ScriptResult[]): string[] {
  const failed = results.filter((result) => !result.ok);
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const lines = [
    ...failed.map((result) => `FAIL ${result.script} (exit ${result.exitCode}, ${seconds(result.ms)}): ${result.reason ?? 'no output'}`),
    ...results.filter((result) => result.ok).map((result) => `PASS ${result.script} (${seconds(result.ms)})`),
  ];
  if (!results.length) return ['No tests found: add a Playwright script as tests/<name>.mjs or .cjs (somewhere init writes tests/app-check.mjs), then run somewhere test.'];
  lines.push(failed.length
    ? `FAILED: ${failed.length} of ${results.length} script${results.length === 1 ? '' : 's'} failed. Fix what each FAIL line names, run somewhere deploy, then somewhere test --failed to rerun only the failed checks.`
    : `PASSED: ${results.length} script${results.length === 1 ? '' : 's'}.`);
  return lines;
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
