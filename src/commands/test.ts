import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { prepareRunner, runTests } from '../lib/test-run.js';
import { mark, markProcessStart } from '../lib/test-timeline.js';

export function registerTest(program: Command): void {
  program.command('test [files...]')
    .description('Run project Playwright tests against its canonical production origin')
    .option('--workers <count>', 'Parallel workers', '5')
    .option('--failed', 'Run only the tests that failed on the live release; passed results on it are kept')
    .option('--grep <name>', 'Filter test names (subset)')
    .option('--url <url>', 'Unsupported in phase 1')
    .option('--phone', 'Run every test again in a 390x844 phone viewport ([phone] in results)')
    .option('--json', 'Print structured results')
    .action(async (files: string[], opts: { workers: string; failed?: boolean; grep?: string; url?: string; json?: boolean; phone?: boolean }) => {
      markProcessStart('cli');
      mark('cli:action');
      if (opts.url) throw new Error('--url is unsupported: tests use the linked project canonical production origin only.');
      if (!/^[1-9]\d*$/.test(opts.workers)) throw new Error('--workers must be a positive integer');
      const root = process.cwd();
      const projectId = loadProjectConfig()?.project_id;
      if (!projectId) throw new Error('Run somewhere test from a linked project folder');
      const outcome = await runTests({ root, client: new ApiClient(getToken()), projectId, prepared: prepareRunner(root), options: { ...opts, files } });
      mark('cli:exit');
      process.exitCode = outcome.exitCode;
    });
}
