import { Command } from 'commander';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { productionOrigin, ensurePrivateDir, writePrivateFile } from '../lib/test-identities.js';

export function registerTest(program: Command): void {
  program.command('test [file]')
    .description('Run project Playwright tests against its canonical production origin')
    .option('--workers <count>', 'Parallel workers', '5')
    .option('--failed', 'Run last failures only (subset; a full green is still required)')
    .option('--grep <name>', 'Filter test names (subset)')
    .option('--url <url>', 'Unsupported in phase 1')
    .option('--json', 'Print structured results')
    .action(async (file: string | undefined, opts: { workers: string; failed?: boolean; grep?: string; url?: string; json?: boolean }) => {
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
      const urls = await client.call<{ prod_fallback: string }>('GET', `/projects/${encodeURIComponent(id)}/urls`);
      const { origin } = productionOrigin(urls.prod_fallback);
      const dir = join(root, '.somewhere', 'tests');
      ensurePrivateDir(dir);
      appendFileSync(join(root, '.gitignore'), '\n.somewhere/\nplaywright-report/\ntest-results/\n');
      let channel: 'chrome' | undefined = 'chrome';
      let browser;
      try { browser = await pw.chromium.launch({ channel: 'chrome' }); }
      catch (error) {
        if (!(error instanceof Error) || !/not found|doesn't exist|not installed/i.test(error.message)) throw error;
        channel = undefined;
        process.stderr.write('Chrome is not installed; installing Playwright Chromium in the CLI cache.\n');
        process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(dir, 'browsers');
        const install = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit', env: process.env });
        if (install.status !== 0) throw new Error('Playwright Chromium installation failed');
        browser = await pw.chromium.launch();
      }
      const version = browser.version();
      await browser.close();
      const subset = Boolean(file || opts.grep || opts.failed);
      const config = join(dir, 'runner.config.cjs');
      writePrivateFile(config, `module.exports = ${JSON.stringify({ testDir: join(root, 'tests'), fullyParallel: true, forbidOnly: !subset, retries: 0, workers: Number(opts.workers), outputDir: join(dir, 'artifacts'), reporter: [[join(dirname(fileURLToPath(import.meta.url)), '../lib/test-reporter.js')]], use: { baseURL: origin, channel, trace: 'off', video: 'off', screenshot: 'off' } })};\n`);
      const args = [cli, 'test', '--config', config];
      if (file) args.push(file);
      if (opts.grep) args.push('--grep', opts.grep);
      if (opts.failed) args.push('--last-failed');
      const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, SW_TEST_ORIGIN: origin, SW_TEST_BROWSER: `${channel ?? 'chromium'} ${version}`, SW_TEST_SUBSET: String(subset), SW_TEST_JSON: String(Boolean(opts.json)), SW_TEST_RESULTS: join(dir, 'results.json') } });
      process.exitCode = result.status ?? 1;
    });
}
