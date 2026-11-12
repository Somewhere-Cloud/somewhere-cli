import type { Reporter, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { writePrivateFile } from './test-identities.js';
export default class TestReporter implements Reporter {
  private total = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  onBegin(_config: unknown, suite: Suite): void { this.total = suite.allTests().length; }
  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'skipped') this.skipped++;
    else if (result.status === test.expectedStatus) this.passed++;
    else this.failed++;
    // Arbitrary assertion diffs can contain credentials. Do not serialize them.
    if (process.env.SW_TEST_JSON !== 'true') console.log(`${result.status}: ${test.title.replace(/[^\w .-]/g, '_')} ${result.status !== test.expectedStatus ? '(assertion or setup failed; inspect the test assertion)' : ''}`);
  }
  onError(): void { this.failed++; }
  async onEnd(result: FullResult): Promise<{ status: 'failed' | 'passed' }> {
    const notRun = Math.max(0, this.total - this.passed - this.failed - this.skipped);
    const report = { passed: this.passed, failed: this.failed, skipped: this.skipped, notRun, target: process.env.SW_TEST_ORIGIN, release: 'release unknown', browser: process.env.SW_TEST_BROWSER, duration: result.duration, subset: process.env.SW_TEST_SUBSET === 'true' };
    writePrivateFile(process.env.SW_TEST_RESULTS!, JSON.stringify(report) + '\n');
    console.log(process.env.SW_TEST_JSON === 'true' ? JSON.stringify(report) : `${report.subset ? 'SUBSET (not a full green): ' : 'FULL: '}${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped, ${report.notRun} not run · ${report.target} · release unknown · ${report.browser} · ${(report.duration / 1000).toFixed(1)} s`);
    return { status: result.status === 'passed' && this.failed === 0 && this.passed > 0 ? 'passed' : 'failed' };
  }
}
