import type { Reporter, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { writePrivateFile } from './test-identities.js';
import { scrub, type Diagnostics } from './test-diagnostics.js';
interface Entry extends Diagnostics { title: string; status: string; errors: string[]; step: string }
export default class TestReporter implements Reporter {
  private total = 0;
  private errors = 0;
  private entries: Entry[] = [];
  onBegin(_config: unknown, suite: Suite): void { this.total = suite.allTests().length; }
  onTestEnd(test: TestCase, result: TestResult): void {
    const attachment = result.attachments.find(item => item.name === 'somewhere-diagnostics');
    const details = attachment?.body ? JSON.parse(attachment.body.toString()) as Diagnostics & { title: string; errors: string[] } : { title: scrub(test.title), errors: ['Test failed before fixture setup'], timings: {} };
    const entry: Entry = { ...details, status: result.status, errors: details.errors.map(message => message.split('\n').find(line => line.trim())?.slice(0, 300) ?? 'Test failed'), step: result.steps.find(step => step.error)?.category ?? 'test body' };
    this.entries.push(entry);
    if (process.env.SW_TEST_JSON !== 'true') {
      console.log(`${result.status}: ${entry.title}`);
      if (result.status !== 'passed' && result.status !== 'skipped') console.log(`  step: ${entry.step}; ${entry.errors.join('; ')}\n  ${entry.request ? `${entry.request.method} ${entry.request.path} · HTTP ${entry.request.status} · ${entry.request.code}` : 'request: none'}\n  screenshot: ${entry.screenshot ?? 'not captured (setup/auth page)'} `);
    }
  }
  onError(): void { this.errors++; }
  async onEnd(result: FullResult): Promise<{ status: 'failed' | 'passed' }> {
    const passed = this.entries.filter(entry => entry.status === 'passed').length;
    const skipped = this.entries.filter(entry => entry.status === 'skipped').length;
    const failed = this.entries.length - passed - skipped;
    const report = { passed, failed, skipped, notRun: Math.max(0, this.total - this.entries.length), setupErrors: this.errors, target: process.env.SW_TEST_ORIGIN, release: process.env.SW_TEST_RELEASE ?? 'release unknown', browser: process.env.SW_TEST_BROWSER, duration: result.duration, browserProbeMs: Number(process.env.SW_TEST_BROWSER_LAUNCH_MS), subset: process.env.SW_TEST_SUBSET === 'true', tests: this.entries };
    writePrivateFile(process.env.SW_TEST_RESULTS!, JSON.stringify(report) + '\n');
    console.log(process.env.SW_TEST_JSON === 'true' ? JSON.stringify(report) : `${report.subset ? 'SUBSET (not a full green; passed tests previously failed when using --failed): ' : 'FULL: '}${passed} passed, ${failed} failed, ${skipped} skipped, ${report.notRun} not run · ${report.target} · ${report.release} · ${report.browser} · ${(result.duration / 1000).toFixed(1)} s`);
    return { status: result.status === 'passed' && failed === 0 && this.errors === 0 && passed > 0 ? 'passed' : 'failed' };
  }
}
