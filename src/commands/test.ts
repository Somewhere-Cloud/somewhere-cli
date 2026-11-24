import { Command } from 'commander';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { prepareRunner, runTests } from '../lib/test-run.js';
import { mark, markProcessStart } from '../lib/test-timeline.js';
import { referenceCheckNote } from '../lib/reference-check-note.js';
import { checksJsonReport, deployChecksSummary, formatChecksReport, runChecksNow, type AccessCheck } from '../lib/deploy-checks.js';
import { checkSummaryExitCode } from '../lib/check-summary.js';
import { describeScriptResults, hasSpecFiles, isScript, lastFailedScripts, listScripts, recordScriptResults, runScripts } from '../lib/test-scripts.js';

export function registerTest(program: Command): void {
  program.command('test [files...]')
    .description('Read the live release\'s latest checks, run in Somewhere\'s browser: your saved checks/*.json journeys, the stranger and signed-out access probes and a page crawl (the same check that runs after every deploy). Exits 0 when they pass, 1 for a named failure, or 2 when a check or cleanup could not finish. With a file, runs that tests/*.mjs or *.cjs script; a project with tests/**/*.spec.ts runs its Playwright specs (--preview: this folder\'s open preview)')
    .option('--preview', 'Test this folder\'s open preview (its own users, data copy and captured mail), pinned to the version saved when the run starts. Production is never touched.')
    .option('--workers <count>', 'Parallel workers', '5')
    .option('--again', 'Start a fresh run of the checks on the live release instead of reading the result of the last deploy\'s run')
    .option('--failed', 'Rerun what failed last time: each failed tests/*.mjs or *.cjs script, all its checks (specs: only the failed tests)')
    .option('--fail-fast', 'Stop app-check scripts at their first failed check')
    .option('--grep <name>', 'Filter test names (subset)')
    .option('--url <url>', 'Unsupported in phase 1')
    .option('--phone', 'Run every test again in a 390x844 phone viewport ([phone] in results)')
    .option('--json', 'Print structured results')
    .option('--verbose', 'Also print where the full result file is when everything passed')
    .addHelpText('after', '\nSave each journey you want re-checked after every deploy as checks/<plain-name>.json; the platform runs them in its browser after each deploy and `somewhere test` reads the latest result. Use --again for a fresh run. The last line of a platform run is JSON with outcome and counts.\n')
    .action(async (files: string[], opts: { workers: string; again?: boolean; failed?: boolean; failFast?: boolean; grep?: string; url?: string; json?: boolean; phone?: boolean; preview?: boolean; verbose?: boolean }) => {
      markProcessStart('cli');
      mark('cli:action');
      if (opts.url) throw new Error('--url is unsupported: tests use the linked project canonical production origin only.');
      if (!/^[1-9]\d*$/.test(opts.workers)) throw new Error('--workers must be a positive integer');
      const root = process.cwd();
      const projectId = loadProjectConfig()?.project_id;
      if (!projectId) throw new Error('Run somewhere test from a linked project folder');
      // No file, no specs, no preview: the platform runs the live release's checks in its own browser.
      if (!files.length && !opts.preview && !opts.failed && !hasSpecFiles(root)) {
        const unsupported = [opts.phone && '--phone', opts.grep && '--grep', opts.workers !== '5' && '--workers', opts.failFast && '--fail-fast'].filter(Boolean);
        if (unsupported.length) throw new Error(`${unsupported.join(', ')} apply to Playwright specs and scripts; the platform runs checks/*.json as saved.`);
        let check: AccessCheck | null;
        try {
          check = await runChecksNow(new ApiClient(getToken()), projectId, { again: opts.again === true });
        } catch (cause) {
          check = { status: 'unavailable', sentence: cause instanceof Error ? cause.message : 'The platform could not start the checks.' };
        }
        mark('cli:exit');
        const summary = deployChecksSummary(check);
        if (opts.json) process.stdout.write(JSON.stringify(checksJsonReport(check)) + '\n');
        else process.stdout.write(formatChecksReport(check).join('\n') + '\n');
        process.exitCode = checkSummaryExitCode(summary);
        return;
      }
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
        if (opts.failFast) process.env.SW_TEST_FAIL_FAST = '1';
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
      if (opts.failFast) throw new Error('--fail-fast applies to app-check scripts (tests/*.mjs or *.cjs).');
      // A preview run carries only the preview's own credential: your sign-in is not read at all.
      const outcome = await runTests({ root, ...(opts.preview ? {} : { client: new ApiClient(getToken()) }), projectId, prepared: prepareRunner(root), options: { ...opts, files } });
      await note;
      mark('cli:exit');
      process.exitCode = outcome.exitCode;
    });
}
