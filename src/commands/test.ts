import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { prepareRunner, runTests } from '../lib/test-run.js';
import { mark, markProcessStart } from '../lib/test-timeline.js';
import { referenceCheckNote } from '../lib/reference-check-note.js';
import { describeScriptResults, hasSpecFiles, isScript, lastFailedScripts, listScripts, recordScriptResults, runScripts } from '../lib/test-scripts.js';

export function registerTest(program: Command): void {
  program.command('test [files...]')
    .description('Run this project\'s tests: every tests/*.mjs and tests/*.cjs script (such as tests/app-check.mjs), or, when the project has tests/**/*.spec.ts, its Playwright specs against the live release (--preview: this folder\'s open preview)')
    .option('--preview', 'Test this folder\'s open preview (its own users, data copy and captured mail), pinned to the version saved when the run starts. Production is never touched.')
    .option('--workers <count>', 'Parallel workers', '5')
    .option('--failed', 'Rerun what failed last time: each failed tests/*.mjs or *.cjs script, all its checks (specs: only the failed tests)')
    .option('--grep <name>', 'Filter test names (subset)')
    .option('--url <url>', 'Unsupported in phase 1')
    .option('--phone', 'Run every test again in a 390x844 phone viewport ([phone] in results)')
    .option('--json', 'Print structured results')
    .option('--verbose', 'Also print where the full result file is when everything passed')
    .action(async (files: string[], opts: { workers: string; failed?: boolean; grep?: string; url?: string; json?: boolean; phone?: boolean; preview?: boolean; verbose?: boolean }) => {
      markProcessStart('cli');
      mark('cli:action');
      if (opts.url) throw new Error('--url is unsupported: tests use the linked project canonical production origin only.');
      if (!/^[1-9]\d*$/.test(opts.workers)) throw new Error('--workers must be a positive integer');
      const root = process.cwd();
      const projectId = loadProjectConfig()?.project_id;
      if (!projectId) throw new Error('Run somewhere test from a linked project folder');
      // The last deploy's background reference check: one line when it is not clean, printed as soon as it is read.
      // Production runs only (a preview has its own saved version). The read takes about a second, so the tests do not
      // wait for it; the results do.
      const note = (opts.preview ? Promise.resolve(null) : referenceCheckNote(() => new ApiClient(getToken()), projectId))
        .then((line) => { if (line) process.stderr.write(line + '\n'); });
      // No specs: the project's tests are ordinary scripts, each its own verdict.
      if (files.length ? files.every(isScript) : !hasSpecFiles(root)) {
        const unsupported = [opts.preview && '--preview', opts.phone && '--phone', opts.grep && '--grep', opts.workers !== '5' && '--workers'].filter(Boolean);
        if (unsupported.length) throw new Error(`${unsupported.join(', ')} apply to tests/**/*.spec.ts. A script chooses its own target and checks (openAppTest({ preview: true }) for a preview).`);
        const scripts = opts.failed ? lastFailedScripts(root) : listScripts(root, files);
        if (opts.failed && !scripts.length) throw new Error('No failed scripts are recorded from the last run here; run somewhere test.');
        const results = await runScripts(root, scripts, []);
        await note;
        if (results.length) recordScriptResults(root, results, Boolean(opts.failed));
        mark('cli:exit');
        const failed = results.filter((result) => !result.ok).length;
        if (opts.json) process.stdout.write(JSON.stringify({ passed: results.length - failed, failed, scripts: results }, null, 2) + '\n');
        else process.stdout.write('\n' + describeScriptResults(results, { verbose: Boolean(opts.verbose) }).join('\n') + '\n');
        process.exitCode = failed || !results.length ? 1 : 0;
        return;
      }
      // A preview run carries only the preview's own credential: your sign-in is not read at all.
      const outcome = await runTests({ root, ...(opts.preview ? {} : { client: new ApiClient(getToken()) }), projectId, prepared: prepareRunner(root), options: { ...opts, files } });
      await note;
      mark('cli:exit');
      process.exitCode = outcome.exitCode;
    });
}
