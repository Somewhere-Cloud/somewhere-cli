import { relative } from 'node:path';
import { ApiClient } from './client.js';
import { getToken, loadProjectConfig } from './config.js';
import { liveReleaseId } from './test-target.js';
import type { Reporter, FullResult, Suite, TestCase, TestResult, TestError } from '@playwright/test/reporter';
import { writePrivateFile } from './test-identities.js';
import { scrub, describeError, titled, type Diagnostics } from './test-diagnostics.js';
import { mark, markProcessStart, span } from './test-timeline.js';
import { recordRun, type LedgerOutcome, type RanTest } from './test-ledger.js';
markProcessStart('playwright');
interface Entry extends Diagnostics { title: string; status: string; outcome: string; errors: string[]; step: string; file: string; line: number }

/** The titles of the describe blocks and the test itself, outermost first. */
function titlePath(test: TestCase): string[] {
  const path = [test.title];
  for (let suite: Suite | undefined = test.parent; suite && suite.type === 'describe'; suite = suite.parent) path.unshift(suite.title);
  return path;
}
const firstLine = (message: string): string => message.replace(/^[^:\n]+:\d+: /, '').split('\n').find(line => line.trim())?.trim().slice(0, 240) ?? '';

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
    const releases = new Set([process.env.SW_TEST_RELEASE, ...this.entries.map(entry => entry.release)].filter(Boolean));
    const projectId = loadProjectConfig()?.project_id;
    if (projectId && releases.size) {
      try {
        releases.add(await span('release-check', {}, () => liveReleaseId(new ApiClient(getToken()), projectId)));
      } catch { this.errors++; console.error('Could not verify release at end of run'); }
    }
    const release = releases.size === 1 ? [...releases][0]! : null;
    const subset = process.env.SW_TEST_SUBSET === 'true';
    // Results on this exact release, kept for a focused rerun; a run whose release changed records nothing.
    const ledger: LedgerOutcome = projectId
      ? recordRun(process.cwd(), { projectId, release, ran: this.ran })
      : { kept: [], dropped: [], all: [], changedFiles: [] };
    const flags = process.env.SW_TEST_RERUN_FLAGS ?? '';
    const stillFailing = ledger.all.filter(entry => entry.status !== 'passed' && entry.status !== 'skipped');
    const rerun = release && stillFailing.length ? `somewhere test --failed${flags}` : null;
    const report = {
      passed, failed, skipped, expectedFailures, setupDiagnostics: this.setupDiagnostics, notRun: Math.max(0, this.total - this.entries.length), setupErrors: this.errors, target: process.env.SW_TEST_ORIGIN,
      release: releases.size > 1 ? 'release changed during run' : release ?? 'release unavailable (no access map)',
      browser: process.env.SW_TEST_BROWSER, duration: result.duration, browserProbeMs: Number(process.env.SW_TEST_BROWSER_LAUNCH_MS), subset,
      tests: this.entries,
      // Earlier results on the same release, spec and test hash; never counted in passed/failed above.
      kept: ledger.kept.map(({ file, line, title, project, status, release, specHash, testHash, at }) => ({ file, line, title: project === 'phone' ? `[phone] ${title}` : title, status, release, specHash, testHash, at })),
      dropped: ledger.dropped,
      rerun,
      onRelease: release ? { tests: ledger.all.length, passed: ledger.all.filter(entry => entry.status === 'passed').length, failing: stillFailing.length } : null,
    };
    writePrivateFile(process.env.SW_TEST_RESULTS!, JSON.stringify(report) + '\n');
    mark('runner:end', { passed, failed });
    if (process.env.SW_TEST_JSON === 'true') console.log(JSON.stringify(report));
    else {
      console.log(`${subset ? 'SUBSET (filtered or last failures only): ' : 'FULL: '}${passed} passed, ${failed} failed, ${expectedFailures} expected failures, ${this.errors} setup errors, ${skipped} skipped, ${report.notRun} not run · ${report.target} · ${report.release} · ${report.browser} · ${(result.duration / 1000).toFixed(1)} s`);
      for (const reason of ledger.dropped) console.log(`Earlier results no longer count: ${reason}.`);
      if (ledger.changedFiles.length) console.log(`Run those again: somewhere test ${ledger.changedFiles.join(' ')}${flags}`);
      if (ledger.kept.length) {
        const count = (status: string) => ledger.kept.filter(entry => status === 'failed' ? entry.status !== 'passed' && entry.status !== 'skipped' : entry.status === status).length;
        console.log(`KEPT from earlier runs on ${release} (same release, spec and test unchanged; not rerun): ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped`);
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
      const keptFailing = ledger.kept.filter(entry => entry.status !== 'passed' && entry.status !== 'skipped');
      if (keptFailing.length) console.log(`Still failing on this release from an earlier run: ${keptFailing.map(entry => `${entry.file} › ${entry.title}`).join('; ')}`);
      if (rerun) console.log(`After fixing a test, run only what failed, on the same release: ${rerun}\nAfter fixing the app, deploy, then run somewhere test${flags}.`);
      else if (release && ledger.all.length && !this.errors && failed === 0 && !ledger.changedFiles.length) {
        const now = this.entries.filter(entry => entry.status === 'passed').length;
        console.log(`Every test recorded on ${release} has passed (${now} in this run${ledger.kept.length ? `, ${ledger.kept.filter(entry => entry.status === 'passed').length} kept` : ''}). Do not run this suite again on this release.`);
      }
    }
    const status = result.status === 'passed' && failed === 0 && this.errors === 0 && passed > 0 ? 'passed' : 'failed';
    if (status === 'passed' && process.env.SW_TEST_JSON !== 'true') console.log('The checks you wrote passed; say which requirements they do not cover.');
    return { status };
  }
}
