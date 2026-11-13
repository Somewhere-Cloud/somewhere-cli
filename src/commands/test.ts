import { loadTestTarget } from '../lib/test-target.js';
import { testAddressOrder } from '../lib/test-connectivity.js';
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { ApiClient } from '../lib/client.js';
import { cliConfigDir, getToken, loadProjectConfig } from '../lib/config.js';
import { ensurePrivateDir, writePrivateFile } from '../lib/test-identities.js';
import { describeSweep, sweepAccounts } from '../lib/form-accounts.js';

export function registerTest(program: Command): void {
  program.command('test [file]')
    .description('Run project Playwright tests against its canonical production origin')
    .option('--workers <count>', 'Parallel workers', '5')
    .option('--failed', 'Run last failures only (subset)')
    .option('--grep <name>', 'Filter test names (subset)')
    .option('--url <url>', 'Unsupported in phase 1')
    .option('--phone', 'Run every test again in a 390x844 phone viewport ([phone] in results)')
    .option('--json', 'Print structured results')
    .action(async (file: string | undefined, opts: { workers: string; failed?: boolean; grep?: string; url?: string; json?: boolean; phone?: boolean }) => {
      if (opts.url) throw new Error('--url is unsupported: tests use the linked project canonical production origin only.');
      if (!/^[1-9]\d*$/.test(opts.workers)) throw new Error('--workers must be a positive integer');
      const root = process.cwd();
      const require = createRequire(join(root, 'package.json'));
      let cli: string;
      let pw: typeof import('@playwright/test');
      try { cli = require.resolve('@playwright/test/cli'); pw = require('@playwright/test') as typeof import('@playwright/test'); }
      catch { throw new Error('Install project test dependencies: npm install -D @playwright/test @somewhere-cloud/cli'); }
      const id = loadProjectConfig()?.project_id;
      if (!id) throw new Error('Run somewhere test from a linked project folder');
      const client = new ApiClient(getToken());
      const target = await loadTestTarget(client, id);
      const { origin } = target;
      const addressOrder = testAddressOrder(origin);
      const dir = join(root, '.somewhere', 'tests');
      ensurePrivateDir(dir);
      const ignorePath = join(root, '.gitignore');
      const ignored = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
      for (const line of ['.somewhere/', 'playwright-report/', 'test-results/']) if (!ignored.split(/\r?\n/).includes(line)) appendFileSync(ignorePath, `\n${line}\n`);
      let channel: 'chrome' | undefined = 'chrome';
      let browser;
      const launchStart = performance.now();
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
      const ipv4First = await addressOrder;
      const runnerEnv = { ...process.env, ...(ipv4First ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --dns-result-order=ipv4first` } : {}) }; 
      const subset = Boolean(file || opts.grep || opts.failed);
      // Form sign-up accounts (signUp fixture) left by an interrupted earlier run are finished first.
      process.env.SW_TEST_RUN = randomUUID();
      for (const line of describeSweep(await sweepAccounts(client, root, id), 'Before this run')) process.stderr.write(line + '\n');
      const config = join(dir, 'runner.config.cjs');
      const artifacts = join(dir, createHash('sha256').update(id + origin).digest('hex').slice(0, 16));
      if (opts.failed) {
        const lastRun = join(artifacts, '.last-run.json');
        if (!existsSync(lastRun) || !(JSON.parse(readFileSync(lastRun, 'utf8')) as { failedTests?: string[] }).failedTests?.length) throw new Error('No previous failed tests for this project and target; run somewhere test in full.');
      }
      writePrivateFile(config, `module.exports = ${JSON.stringify({ testDir: join(root, 'tests'), testMatch: '**/*.spec.ts', fullyParallel: true, forbidOnly: !subset, retries: 0, workers: Number(opts.workers), outputDir: artifacts, reporter: [[join(dirname(fileURLToPath(import.meta.url)), '../lib/test-reporter.js')]], use: { baseURL: origin, channel, trace: 'off', video: 'off', screenshot: 'off' }, ...(opts.phone ? { projects: [{ name: 'desktop' }, { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }] } : {}) })};\n`);
      const args = [cli, 'test', '--config', config];
      if (file) args.push(file);
      if (opts.grep) args.push('--grep', opts.grep);
      if (opts.failed) args.push('--last-failed');
      const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...runnerEnv, SW_TEST_TARGET: JSON.stringify(target), SW_TEST_RELEASE: target.releaseId, SW_TEST_ORIGIN: origin, SW_TEST_BROWSER_LAUNCH_MS: String(browserLaunchMs), SW_TEST_BROWSER: `${channel ?? 'chromium'} ${version}`, SW_TEST_SUBSET: String(subset), SW_TEST_JSON: String(Boolean(opts.json)), SW_TEST_RESULTS: join(dir, 'results.json'), SW_TEST_RUN: process.env.SW_TEST_RUN, SW_TEST_RUN_PID: String(process.pid) } });
      // Anything a test's own cleanup could not finish (its record is kept) is retried once more here.
      const after = await sweepAccounts(client, root, id).catch(error => { process.stderr.write(`Could not finish form sign-up cleanup: ${error instanceof Error ? error.message : String(error)}\n`); return null; });
      const leftover = after ? describeSweep(after, 'After this run') : [];
      for (const line of leftover) process.stderr.write(line + '\n');
      // Playwright may create raw error-context text; retain only screenshots and rerun state.
      const cleanArtifacts = (path: string): void => {
        if (!existsSync(path)) return;
        for (const entry of readdirSync(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) cleanArtifacts(file); else if (entry.name !== '.last-run.json' && !entry.name.endsWith('.png')) rmSync(file); }
      };
      cleanArtifacts(artifacts);
      process.exitCode = result.status === null ? 1 : result.status || (after === null || after.failed.length || after.unknownId.length ? 1 : 0);
    });
}
