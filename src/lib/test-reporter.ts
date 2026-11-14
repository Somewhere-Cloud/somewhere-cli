import { relative } from 'node:path';
import { ApiClient } from './client.js';
import { getToken, loadProjectConfig } from './config.js';
import { liveReleaseId } from './test-target.js';
import type { Reporter, FullResult, Suite, TestCase, TestResult, TestError } from '@playwright/test/reporter';
import { writePrivateFile } from './test-identities.js';
import { scrub, describeError, titled, type Diagnostics } from './test-diagnostics.js';
import { mark, markProcessStart, span } from './test-timeline.js';
markProcessStart('playwright');
interface Entry extends Diagnostics { title: string; status: string; outcome: string; errors: string[]; step: string; file: string; line: number }

const firstLine = (message: string): string => message.replace(/^[^:\n]+:\d+: /, '').split('\n').find(line => line.trim())?.trim().slice(0, 240) ?? '';

/** The one release a run's results describe: confirmed at the end and the same as at the start
 *  (and as every fixture saw), or null. */
export function confirmedRelease(start: string | undefined, seen: (string | undefined)[], live: string | null): string | null {
  if (!start || !live) return null;
  const all = new Set([start, live, ...seen.filter(Boolean)]);
  return all.size === 1 ? start : null;
}

export default class TestReporter implements Reporter {
  private total = 0;
  private errors = 0;
  private setupDiagnostics: { file?: string; message: string }[] = [];
  private entries: Entry[] = [];
  onBegin(_config: unknown, suite: Suite): void { this.total = suite.allTests().length; mark('runner:begin', { tests: this.total }); }
  onTestBegin(test: TestCase, result: TestResult): void { mark('test:start', { test: titled(test.parent?.project?.()?.name, scrub(test.title)), worker: result.workerIndex }); }
  onTestEnd(test: TestCase, result: TestResult): void {
    mark('test:end', { test: titled(test.parent?.project?.()?.name, scrub(test.title)), worker: result.workerIndex, status: result.status, ms: result.duration });
    const attachment = result.attachments.find(item => item.name === 'somewhere-diagnostics');
    const details = attachment?.body ? JSON.parse(attachment.body.toString()) as Diagnostics & { title: string; errors: string[] } : { title: titled(test.parent?.project?.()?.name, scrub(test.title)), errors: ['Test failed before fixture setup'], timings: {} };
    // The assertion with expected/received, scrubbed in the worker that knows the issued secrets;
    // file:line from Playwright's error location. Never reduced to a category.
    const errors = attachment?.body
      ? details.errors.map((message, i) => { const location = result.errors[i]?.location; return location ? describeError({ message: '', location }).replace(/: $/, '') + ': ' + message : message; })
      : result.errors.map(error => describeError(error));
    const file = relative(process.cwd(), test.location.file);
    const entry: Entry = { ...details, status: result.status, outcome: test.outcome(), title: scrub(details.title).slice(0, 200), errors, step: result.steps.find(step => step.error)?.category ?? 'test body', file, line: test.location.line };
    this.entries.push(entry);
    if (process.env.SW_TEST_JSON !== 'true') {
      console.log(`${result.status}: ${entry.title}`);
      if (result.status !== 'passed' && result.status !== 'skipped') console.log(`  step: ${entry.step}\n${entry.errors.map(error => '  ' + error.replaceAll('\n', '\n  ')).join('\n')}\n  last request: ${entry.request ? `${entry.request.method} ${entry.request.path} · HTTP ${entry.request.status} · ${entry.request.code}` : 'none'}\n  screenshot: ${entry.screenshot ?? 'not captured (setup/auth page)'}`);
    }
  }
  onError(error: TestError): void { this.errors++; const detail = { file: error.location ? describeError({ message: '', location: error.location }).replace(/: $/, '') : undefined, message: describeError({ message: error.message, value: error.value }) }; this.setupDiagnostics.push(detail); console.error(`Setup error: ${detail.file ?? 'collection'}: ${detail.message}`); }
  async onEnd(result: FullResult): Promise<{ status: 'failed' | 'passed' }> {
    const passed = this.entries.filter(entry => entry.status === 'passed' && entry.outcome === 'expected').length;
    const skipped = this.entries.filter(entry => entry.status === 'skipped').length;
    const expectedFailures = this.entries.filter(entry => entry.status === 'failed' && entry.outcome === 'expected').length;
    const failed = this.entries.filter(entry => entry.outcome === 'unexpected').length;
    const startRelease = process.env.SW_TEST_RELEASE;
    const releases = new Set([startRelease, ...this.entries.map(entry => entry.release)].filter(Boolean));
    const projectId = loadProjectConfig()?.project_id;
    // The release must be the same at the end as at the start (and as every fixture saw); otherwise
    // these results describe no single release and the run fails.
    let release: string | null = null;
    if (projectId && startRelease) {
      const live = await span('release-check', {}, () => liveReleaseId(new ApiClient(getToken()), projectId)).catch(() => null);
      if (live) releases.add(live);
      release = confirmedRelease(startRelease, this.entries.map(entry => entry.release), live);
      if (!release) {
        this.errors++;
        console.error(releases.size > 1
          ? `The release changed during this run (${[...releases].join(' → ')}): these results describe no single release, so the run fails. Run the tests again.`
          : 'The live release could not be confirmed at the end of this run, so the run fails. Run the tests again.');
      }
    }
    const subset = process.env.SW_TEST_SUBSET === 'true';
    const flags = process.env.SW_TEST_RERUN_FLAGS ?? '';
    const failures = this.entries.filter(entry => entry.outcome === 'unexpected');
    const rerun = failures.length ? `somewhere test --failed${flags}` : null;
    const report = {
      passed, failed, skipped, expectedFailures, setupDiagnostics: this.setupDiagnostics, notRun: Math.max(0, this.total - this.entries.length), setupErrors: this.errors, target: process.env.SW_TEST_ORIGIN,
      release: releases.size > 1 ? 'release changed during run' : release ?? (startRelease ? 'release not confirmed' : 'release unavailable'),
      releaseConfirmed: Boolean(release),
      browser: process.env.SW_TEST_BROWSER, duration: result.duration, browserProbeMs: Number(process.env.SW_TEST_BROWSER_LAUNCH_MS), subset,
      tests: this.entries,
      rerun,
    };
    writePrivateFile(process.env.SW_TEST_RESULTS!, JSON.stringify(report) + '\n');
    mark('runner:end', { passed, failed });
    if (process.env.SW_TEST_JSON === 'true') console.log(JSON.stringify(report));
    else {
      // Exactly what ran in this invocation; a filtered or --failed run is a SUBSET, never a full result.
      console.log(`${subset ? 'SUBSET (only the tests selected for this run): ' : 'FULL: '}${passed} passed, ${failed} failed, ${expectedFailures} expected failures, ${this.errors} setup errors, ${skipped} skipped, ${report.notRun} not run · ${report.target} · ${report.release} · ${report.browser} · ${(result.duration / 1000).toFixed(1)} s`);
      if (failures.length) {
        console.log('Failed:');
        for (const entry of failures) {
          const at = /^([^\s:]+\.ts:\d+): /.exec(entry.errors[0] ?? '')?.[1];
          console.log(`  ${at ?? `${entry.file}:${entry.line}`} ${entry.title}${at && at !== `${entry.file}:${entry.line}` ? ` (test at line ${entry.line})` : ''}\n    ${firstLine(entry.errors[0] ?? '') || 'see the error above'}`);
        }
        console.log(`Rerun the failed tests on the same release: ${rerun}`);
      }
      if (skipped) console.log(`${skipped} skipped: a skipped test proves nothing until it runs.`);
    }
    const status = result.status === 'passed' && failed === 0 && this.errors === 0 && passed > 0 ? 'passed' : 'failed';
    if (status === 'passed' && process.env.SW_TEST_JSON !== 'true') console.log('The checks you wrote passed; say which requirements they do not cover.');
    return { status };
  }
}
