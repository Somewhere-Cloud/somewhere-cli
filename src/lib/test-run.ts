import { CLI_PACKAGE_ROOT } from './package-root.js';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readProjectPin } from './project-pin.js';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { ApiClient } from './client.js';
import { cliConfigDir } from './config.js';
import { ensurePrivateDir, writePrivateFile } from './test-identities.js';
import { describeSweep, sweepAccounts } from './form-accounts.js';
import { loadTestTarget, type TestTarget } from './test-target.js';
import { openPreviewControl, productionControl, type TestControl } from './test-control.js';
import { testAddressOrder } from './test-connectivity.js';
import { INSTALL_PROJECT_DEPENDENCIES, missingProjectDependencies } from './typecheck.js';
import { mark, span } from './test-timeline.js';

export interface PreparedRunner { cli: string; channel: 'chrome' | undefined; version: string; browserLaunchMs: number; playwright: string }
export interface RunOptions { workers: string; files?: string[]; grep?: string; failed?: boolean; json?: boolean; phone?: boolean; preview?: boolean }
export interface RunOutcome { exitCode: number; results: Record<string, unknown> | null; target: TestTarget }

export function testImportEnv(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!readProjectPin(root)?.versionOnly) return env;
  const hook = pathToFileURL(join(CLI_PACKAGE_ROOT, 'bin', 'starter-test-imports.mjs'));
  return { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, '--import=' + hook.href].filter(Boolean).join(' ') };
}

export function testDependencyError(root: string): Error {
  if (readProjectPin(root)?.versionOnly) {
    return new Error('Install Playwright for this project: npm install -D --save-exact @playwright/test@1.65.0');
  }
  return new Error(missingProjectDependencies(root).includes('@playwright/test')
    ? INSTALL_PROJECT_DEPENDENCIES
    : 'Install project test dependencies: npm install -D @playwright/test @somewhere-cloud/cli');
}

/** Resolve the project's Playwright and confirm a browser (installing Chromium only when Chrome is
 *  missing). Local only: no request to the app or the platform, so it can overlap a deploy. */
export async function prepareRunner(root: string): Promise<PreparedRunner> {
  const require = createRequire(join(root, 'package.json'));
  let cli: string;
  let pw: typeof import('@playwright/test');
  try { cli = require.resolve('@playwright/test/cli'); pw = require('@playwright/test') as typeof import('@playwright/test'); }
  catch { throw testDependencyError(root); }
  let channel: 'chrome' | undefined = 'chrome';
  let browser;
  const launchStart = performance.now();
  mark('browser-probe:start');
  try { browser = await pw.chromium.launch({ channel: 'chrome' }); }
  catch (error) {
    if (!(error instanceof Error) || !/not found|doesn't exist|not installed/i.test(error.message)) throw error;
    channel = undefined;
    process.stderr.write('Chrome is not installed; installing Playwright Chromium in the CLI cache.\n');
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(cliConfigDir(), 'cache', 'playwright');
    const install = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit', env: process.env });
    if (install.status !== 0) throw new Error('Playwright Chromium installation failed');
    browser = await pw.chromium.launch();
  }
  const version = browser.version();
  const browserLaunchMs = performance.now() - launchStart;
  await browser.close();
  mark('browser-probe:end');
  let playwright = 'unknown';
  try { playwright = (JSON.parse(readFileSync(join(dirname(cli), 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown'; } catch { /* unknown never matches a kept result's runner */ }
  return { cli, channel, version, browserLaunchMs, playwright };
}

/** Run the project's specs once against its live release, or with options.preview against the
 *  folder's open preview (its own credential only; `client` is not used and may be omitted).
 *  `expectRelease`: refuse to run unless the live release is that one (deploy --test).
 *  `toStderr`: the runner's stdout goes to stderr. */
export async function runTests(input: { root: string; client?: ApiClient; projectId: string; prepared: PreparedRunner | Promise<PreparedRunner>; options: RunOptions; expectRelease?: string; toStderr?: boolean }): Promise<RunOutcome> {
  const { root, projectId, options } = input;
  // The target requests and the local browser probe run at the same time.
  let addressOrder: Promise<boolean> | undefined;
  const loadControl = async (): Promise<TestControl> => {
    if (options.preview) {
      if (input.expectRelease) throw new Error('A preview run is never tied to a production release.');
      const control = await openPreviewControl({ root, projectId });
      addressOrder = testAddressOrder(control.target.origin);
      return control;
    }
    if (!input.client) throw new Error('A production test run needs your sign-in.');
    const client = input.client;
    return productionControl(client, await loadTestTarget(client, projectId, origin => { addressOrder = testAddressOrder(origin); }));
  };
  const [control, prepared] = await Promise.all([loadControl(), input.prepared]);
  const target = control.target;
  if (input.expectRelease && target.releaseId !== input.expectRelease) {
    throw new Error(`The live release is ${target.releaseId}, not ${input.expectRelease} from this deploy (another deploy or rollback happened), so the tests were not run.`);
  }
  const { origin } = target;
  const dir = join(root, '.somewhere', 'tests');
  ensurePrivateDir(dir);
  const ignorePath = join(root, '.gitignore');
  const ignored = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  for (const line of ['.somewhere/', 'playwright-report/', 'test-results/']) if (!ignored.split(/\r?\n/).includes(line)) appendFileSync(ignorePath, `\n${line}\n`);
  const ipv4First = await span('address-probe', {}, () => addressOrder ?? testAddressOrder(origin));
  const runnerEnv = testImportEnv(root, { ...process.env, ...(ipv4First ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --dns-result-order=ipv4first` } : {}) });
  const files = options.files ?? [];
  const failed = Boolean(options.failed);
  const browser = `${prepared.channel ?? 'chromium'} ${prepared.version}`;
  // A preview run keeps its own artifacts per preview and candidate: --failed never reruns another version's failures.
  const artifacts = join(dir, createHash('sha256').update(projectId + origin + (target.environment === 'preview' ? `${target.previewSessionId}:${target.releaseId}` : '')).digest('hex').slice(0, 16));
  if (failed) {
    // Playwright's own record of the last run's failures (kept beside its artifacts). It names what
    // to run; it does not certify anything else as still passing.
    const lastRun = join(artifacts, '.last-run.json');
    if (!existsSync(lastRun) || !(JSON.parse(readFileSync(lastRun, 'utf8')) as { failedTests?: string[] }).failedTests?.length) {
      throw new Error('No failed tests are recorded from the last run here; run somewhere test.');
    }
  }
  const subset = Boolean(files.length || options.grep || failed);
  // Form sign-up accounts (signUp fixture) left by an interrupted earlier run are finished first.
  process.env.SW_TEST_RUN = randomUUID();
  for (const line of describeSweep(await span('sweep:before', {}, () => sweepAccounts(control, root)), 'Before this run')) process.stderr.write(line + '\n');
  const config = join(dir, 'runner.config.cjs');
  // Chrome resolves the app's host through the operating system (as the CLI just did), not its own
  // DNS client: on a resolver whose first nameserver times out, Chrome's own client waited ~2 s in
  // every fresh browser before the first page could load.
  const use = { baseURL: origin, channel: prepared.channel, trace: 'off', video: 'off', screenshot: 'off', launchOptions: { args: ['--disable-features=AsyncDns'] } };
  writePrivateFile(config, `module.exports = ${JSON.stringify({ testDir: join(root, 'tests'), testMatch: '**/*.spec.ts', fullyParallel: true, forbidOnly: !subset, retries: 0, workers: Number(options.workers), outputDir: artifacts, reporter: [[join(CLI_PACKAGE_ROOT, 'dist', 'lib', 'test-reporter.js')]], use, ...(options.phone ? { projects: [{ name: 'desktop' }, { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }] } : {}) })};\n`);
  const args = [prepared.cli, 'test', '--config', config, ...files];
  if (options.grep) args.push('--grep', options.grep);
  if (failed) args.push('--last-failed');
  const rerunFlags = `${options.preview ? ' --preview' : ''}${options.phone ? ' --phone' : ''}${options.workers !== '5' ? ` --workers ${options.workers}` : ''}`;
  const resultsPath = join(dir, 'results.json');
  rmSync(resultsPath, { force: true });
  mark('runner:spawn');
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['inherit', input.toStderr ? 'pipe' : 'inherit', 'inherit'], env: { ...runnerEnv, SW_TEST_TARGET: JSON.stringify(target), SW_TEST_RELEASE: target.releaseId, PLAYWRIGHT_NO_COPY_PROMPT: '1', SW_TEST_ORIGIN: origin, SW_TEST_BROWSER_LAUNCH_MS: String(prepared.browserLaunchMs), SW_TEST_BROWSER: browser, SW_TEST_SUBSET: String(subset), SW_TEST_JSON: String(Boolean(options.json)), SW_TEST_RESULTS: resultsPath, SW_TEST_RUN: process.env.SW_TEST_RUN, SW_TEST_RUN_PID: String(process.pid), SW_TEST_RERUN_FLAGS: rerunFlags } });
  if (input.toStderr) child.stdout?.pipe(process.stderr);
  const status = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
  mark('runner:exit', { status: status ?? -1 });
  // Anything a test's own cleanup could not finish (its record is kept) is retried once more here.
  const after = await span('sweep:after', {}, () => sweepAccounts(control, root).catch(error => { process.stderr.write(`Could not finish form sign-up cleanup: ${error instanceof Error ? error.message : String(error)}\n`); return null; }));
  await control.close();
  for (const line of after ? describeSweep(after, 'After this run') : []) process.stderr.write(line + '\n');
  // Playwright may create raw error-context text; retain only screenshots and rerun state.
  const cleanArtifacts = (path: string): void => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) cleanArtifacts(file); else if (entry.name !== '.last-run.json' && !entry.name.endsWith('.png')) rmSync(file); }
  };
  cleanArtifacts(artifacts);
  const exitCode = status === null ? 1 : status || (after === null || after.failed.length || after.unknownId.length ? 1 : 0);
  const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) as Record<string, unknown> : null;
  return { exitCode, results, target };
}
