import { relative } from 'node:path';
import { ApiClient } from './client.js';
import { getToken, loadProjectConfig } from './config.js';
import { liveReleaseId } from './test-target.js';
import type { Reporter, FullResult, Suite, TestCase, TestResult, TestError } from '@playwright/test/reporter';
import { writePrivateFile } from './test-identities.js';
import { scrub, describeError, titled, type Diagnostics } from './test-diagnostics.js';
import { mark, markProcessStart, span } from './test-timeline.js';
import { recordRun, type Inputs, type LedgerOutcome, type RanTest } from './test-ledger.js';
import { remoteInputs } from './test-inputs.js';
import { existsSync, readFileSync } from 'node:fs';
markProcessStart('playwright');
interface Entry extends Diagnostics { title: string; status: string; outcome: string; errors: string[]; step: string; file: string; line: number }

/** The titles of the describe blocks and the test itself, outermost first. */
function titlePath(test: TestCase): string[] {
  const path = [test.title];
  for (let suite: Suite | undefined = test.parent; suite && suite.type === 'describe'; suite = suite.parent) path.unshift(suite.title);
  return path;
}
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
  private ran: RanTest[] = [];
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
    this.ran.push({ id: test.id, file, line: test.location.line, titlePath: titlePath(test), project: test.parent?.project?.()?.name ?? '', status: test.outcome() === 'unexpected' ? 'failed' : result.status });
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
    // The release (and the platform and environment-variable listing) must be the same at the end as
    // at the start; otherwise these results describe no single release.
    let confirmed = false;
    let remoteChanged = false;
    const startInputs = process.env.SW_TEST_INPUTS && existsSync(process.env.SW_TEST_INPUTS) ? JSON.parse(readFileSync(process.env.SW_TEST_INPUTS, 'utf8')) as Inputs : null;
    if (projectId && startRelease) {
      const client = new ApiClient(getToken());
      try {
        const [live, remote] = await Promise.all([span('release-check', {}, () => liveReleaseId(client, projectId)), remoteInputs(client, projectId)]);
        releases.add(live);
        confirmed = confirmedRelease(startRelease, this.entries.map(entry => entry.release), live) !== null;
        remoteChanged = Boolean(startInputs && (startInputs.platform !== remote.platform || startInputs.env !== remote.env));
      } catch { /* not confirmed */ }
    }
    const release = confirmed ? startRelease! : null;
    if (!release && projectId && startRelease) {
      this.errors++;
      console.error(releases.size > 1
        ? `The release changed during this run (${[...releases].join(' → ')}): these results describe no single release, so the run fails and nothing is kept. Run the tests again.`
        : 'The live release could not be confirmed at the end of this run, so the run fails and nothing is kept. Run the tests again.');
    }
    const subset = process.env.SW_TEST_SUBSET === 'true';
    // Results tied to this exact release and inputs, kept for a focused rerun. A run whose release,
    // platform or environment changed while it ran records nothing.
    const ledger: LedgerOutcome = projectId
      ? recordRun(process.cwd(), { inputs: release && startInputs && !remoteChanged ? startInputs : null, ran: this.ran, full: process.env.SW_TEST_FULL === 'true' })
      : { kept: [], dropped: [], all: [], owed: [], changedFiles: [], complete: false };
    if (remoteChanged) ledger.dropped.unshift('the platform or the environment variables changed during this run');
    const flags = process.env.SW_TEST_RERUN_FLAGS ?? '';
    const rerun = release && ledger.owed.length ? `somewhere test --failed${flags}` : null;
    const count = (list: { status: string }[], status: string) => list.filter(entry => entry.status === status).length;
    const report = {
      passed, failed, skipped, expectedFailures, setupDiagnostics: this.setupDiagnostics, notRun: Math.max(0, this.total - this.entries.length), setupErrors: this.errors, target: process.env.SW_TEST_ORIGIN,
      release: releases.size > 1 ? 'release changed during run' : release ?? 'release not confirmed',
      releaseConfirmed: Boolean(release),
      browser: process.env.SW_TEST_BROWSER, duration: result.duration, browserProbeMs: Number(process.env.SW_TEST_BROWSER_LAUNCH_MS), subset,
      tests: this.entries,
      // Earlier results with the same release and inputs, spec and test; never counted in passed/failed above.
      kept: ledger.kept.map(({ file, line, title, project, status, release, specHash, testHash, at }) => ({ file, line, title: project === 'phone' ? `[phone] ${title}` : title, status, release, specHash, testHash, at })),
      dropped: ledger.dropped,
      owed: ledger.owed.map(({ file, line, title, project, status, was }) => ({ file, line, title: project === 'phone' ? `[phone] ${title}` : title, status, ...(was ? { was } : {}) })),
      rerun,
      // complete: the last full run's tests all have results with these inputs. Only then does
      // onRelease describe the whole suite.
      onRelease: release ? { complete: ledger.complete, tests: ledger.all.length, passed: count(ledger.all, 'passed'), skipped: count(ledger.all, 'skipped'), owed: ledger.owed.length } : null,
    };
    writePrivateFile(process.env.SW_TEST_RESULTS!, JSON.stringify(report) + '\n');
    mark('runner:end', { passed, failed });
    if (process.env.SW_TEST_JSON === 'true') console.log(JSON.stringify(report));
    else {
      console.log(`${subset ? 'SUBSET (filtered or owed tests only; not a full run): ' : 'FULL: '}${passed} passed, ${failed} failed, ${expectedFailures} expected failures, ${this.errors} setup errors, ${skipped} skipped, ${report.notRun} not run · ${report.target} · ${report.release} · ${report.browser} · ${(result.duration / 1000).toFixed(1)} s`);
      for (const reason of ledger.dropped) console.log(`Earlier results no longer count: ${reason}.`);
      if (ledger.kept.length) {
        console.log(`KEPT from earlier runs on ${release} (same release, inputs, spec and test; not rerun): ${count(ledger.kept, 'passed')} passed, ${count(ledger.kept, 'skipped')} skipped`);
        for (const entry of ledger.kept) console.log(`  ${entry.status}: ${entry.project === 'phone' ? '[phone] ' : ''}${entry.title} (${entry.file}, ran ${entry.at.slice(11, 19)} UTC)`);
      }
      const failures = this.entries.filter(entry => entry.outcome === 'unexpected');
      if (failures.length) {
        console.log('Failed:');
        for (const entry of failures) {
          const at = /^([^\s:]+\.ts:\d+): /.exec(entry.errors[0] ?? '')?.[1];
          console.log(`  ${at ?? `${entry.file}:${entry.line}`} ${entry.title}${at && at !== `${entry.file}:${entry.line}` ? ` (test at line ${entry.line})` : ''}\n    ${firstLine(entry.errors[0] ?? '') || 'see the error above'}`);
        }
      }
      const owedElsewhere = ledger.owed.filter(entry => !failures.some(failure => failure.file === entry.file && failure.title.endsWith(entry.title)));
      if (owedElsewhere.length) console.log(`Owed a run on this release: ${owedElsewhere.map(entry => `${entry.file} › ${entry.title} (${entry.status === 'needs-run' ? `changed since it ${entry.was ?? 'ran'}` : entry.status})`).join('; ')}`);
      if (rerun) console.log(`After fixing a test, run only what is owed, on the same release: ${rerun}\nAfter fixing the app, deploy, then run somewhere test${flags}.`);
      else if (release && !this.errors && failed === 0) {
        const allSkipped = count(ledger.all, 'skipped');
        const skippedNote = allSkipped ? ` ${allSkipped} skipped: a skipped test proves nothing until it runs.` : '';
        if (ledger.complete) console.log(`Every test of the full suite has a result on ${release} with these inputs: ${count(ledger.all, 'passed')} passed (${passed} in this run, ${count(ledger.kept, 'passed')} kept).${skippedNote} Do not run the suite again on this release.`);
        else if (subset) console.log(`This was not a full run, and the full suite has no complete result with these inputs: run somewhere test${flags} once.${skippedNote}`);
        else if (skippedNote) console.log(skippedNote.trim());
      }
    }
    const status = result.status === 'passed' && failed === 0 && this.errors === 0 && passed > 0 ? 'passed' : 'failed';
    if (status === 'passed' && process.env.SW_TEST_JSON !== 'true') console.log('The checks you wrote passed; say which requirements they do not cover.');
    return { status };
  }
}
