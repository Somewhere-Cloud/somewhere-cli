import { ApiClient } from './client.js';
import { getToken, loadProjectConfig } from './config.js';
import type { Reporter, FullResult, Suite, TestCase, TestResult, TestError } from '@playwright/test/reporter';
import { writePrivateFile } from './test-identities.js';
import { scrub, describeError, titled, type Diagnostics } from './test-diagnostics.js';
interface Entry extends Diagnostics { title: string; status: string; outcome: string; errors: string[]; step: string }
export default class TestReporter implements Reporter {
  private total = 0;
  private errors = 0;
  private setupDiagnostics: { file?: string; message: string }[] = [];
  private entries: Entry[] = [];
  onBegin(_config: unknown, suite: Suite): void { this.total = suite.allTests().length; }
  onTestEnd(test: TestCase, result: TestResult): void {
    const attachment = result.attachments.find(item => item.name === 'somewhere-diagnostics');
    const details = attachment?.body ? JSON.parse(attachment.body.toString()) as Diagnostics & { title: string; errors: string[] } : { title: titled(test.parent?.project?.()?.name, scrub(test.title)), errors: ['Test failed before fixture setup'], timings: {} };
    // The assertion with expected/received, scrubbed in the worker that knows the issued secrets;
    // file:line from Playwright's error location. Never reduced to a category.
    const errors = attachment?.body
      ? details.errors.map((message, i) => { const location = result.errors[i]?.location; return location ? describeError({ message: '', location }).replace(/: $/, '') + ': ' + message : message; })
      : result.errors.map(error => describeError(error));
    const entry: Entry = { ...details, status: result.status, outcome: test.outcome(), title: scrub(details.title).slice(0, 200), errors, step: result.steps.find(step => step.error)?.category ?? 'test body' };
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
    const releases = new Set([process.env.SW_TEST_RELEASE, ...this.entries.map(entry => entry.release)].filter(Boolean));
    const projectId = loadProjectConfig()?.project_id;
    if (projectId && releases.size) {
      try {
        const map = await new ApiClient(getToken()).call<{ release: { id: string } }>('GET', '/db/access-map', undefined, { project_id: projectId });
        releases.add(map.release.id);
      } catch { this.errors++; console.error('Could not verify release at end of run'); }
    }
    const report = { passed, failed, skipped, expectedFailures, setupDiagnostics: this.setupDiagnostics, notRun: Math.max(0, this.total - this.entries.length), setupErrors: this.errors, target: process.env.SW_TEST_ORIGIN, release: releases.size > 1 ? 'release changed during run' : [...releases][0] ?? 'release unavailable (no access map)' , browser: process.env.SW_TEST_BROWSER, duration: result.duration, browserProbeMs: Number(process.env.SW_TEST_BROWSER_LAUNCH_MS), subset: process.env.SW_TEST_SUBSET === 'true', tests: this.entries };
    writePrivateFile(process.env.SW_TEST_RESULTS!, JSON.stringify(report) + '\n');
    console.log(process.env.SW_TEST_JSON === 'true' ? JSON.stringify(report) : `${report.subset ? 'SUBSET (filtered or last failures only): ' : 'FULL: '}${passed} passed, ${failed} failed, ${expectedFailures} expected failures, ${this.errors} setup errors, ${skipped} skipped, ${report.notRun} not run · ${report.target} · ${report.release} · ${report.browser} · ${(result.duration / 1000).toFixed(1)} s`);
    const status = result.status === 'passed' && failed === 0 && this.errors === 0 && passed > 0 ? 'passed' : 'failed';
    if (status === 'passed' && process.env.SW_TEST_JSON !== 'true') console.log('The checks you wrote passed; say which requirements they do not cover.');
    return { status };
  }
}
