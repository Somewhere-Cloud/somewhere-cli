import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'onboarding-output-'));
process.env.SOMEWHERE_CONFIG_DIR = root;
const { saveVerifyReport, writeVerifyReportTo } = await import('../dist/lib/verify-report.js');
const { formatVerifyOutput, formatVerifySummaryLine, nextFreeOutPath, outExistsMessage, summarizeVerifyReport } = await import('../dist/commands/verify.js');
const { formatTempExpiry } = await import('../dist/commands/deploy.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
const link = 'https://api.example.invalid/screenshot?signature=' + 'long'.repeat(100);
const report = {
  passed: false, verdict: 'FAIL — expected save did not complete',
  steps: [{ step: 1, viewport: 'desktop', passed: false, name: 'Save', error: 'HTTP 403 FORBIDDEN' }],
  health: { page: { passed: true }, console: { passed: false }, network: { passed: false } },
  screenshots: [{ viewport: 'desktop', url: link, url_expires_at: '2026-09-28T23:00:00Z', fs_path: '/_browser_tests/page.jpg' }],
  undeclared_statuses: [],
};
test('human output saves complete private evidence atomically without shortening failures', () => {
  const original = JSON.stringify(report);
  const lines = formatVerifyOutput(report), output = lines.join('\n');
  assert.doesNotMatch(output, /signature=/); assert.match(output, /HTTP 403 FORBIDDEN/); assert.match(output, /console_health: FAIL/);
  const path = lines.at(-1).replace('Full report and screenshot links: ', '');
  assert.equal(JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))), original);
  assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.equal(existsSync(join(dirname(path), 'report.pending')), false);
  assert.equal(JSON.stringify(report), original, 'machine report is untouched');
  const second = saveVerifyReport(report); assert.notEqual(second, path);
  assert.equal(readFileSync(second, 'utf8'), readFileSync(path, 'utf8'));
});
test('report failure retains usable full links and every diagnostic', () => {
  const output = formatVerifyOutput(report, () => { throw new Error('fixture disk failure'); }).join('\n');
  assert.match(output, /Could not save/); assert.ok(output.includes(link)); assert.match(output, /HTTP 403 FORBIDDEN/);
});
test('explicit report stays private and summary omits report values and links', () => {
  const sensitive = { ...report, verdict: 'private verdict',
    steps: [{ ...report.steps[0], value: 'private eval', duration_ms: 12 }],
    dialogs: [{ viewport: 'desktop', detail: { message: 'private dialog' } }] };
  const path = join(root, 'chosen-report.json');
  writeVerifyReportTo(path, sensitive);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), sensitive);
  assert.throws(() => writeVerifyReportTo(path, sensitive), { code: 'EEXIST' });
  const summary = JSON.stringify(summarizeVerifyReport(sensitive));
  assert.match(summary, /"failed_steps":1/);
  assert.match(summary, /"step_duration_ms":12/);
  assert.doesNotMatch(summary, /private|signature=|https:\/\//);
});
test('screenshot capture error remains actionable after report persistence', () => {
  const output = formatVerifyOutput({ ...report, screenshots: [{ viewport: 'mobile', error: 'capture unavailable' }] }).join('\n');
  assert.match(output, /capture unavailable/);
});
test('expiry uses the same server instant for fresh and reused sessions, independent of timezone', () => {
  const now = Date.parse('2026-09-28T18:00:00Z'), expires = '2026-09-28T21:00:00.000Z';
  for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Karachi']) {
    process.env.TZ = zone;
    assert.equal(formatTempExpiry(expires, 10800, now), `Expires at: ${expires} (UTC; about 3h 0m remaining)`);
    assert.equal(formatTempExpiry(expires, undefined, now + 90 * 60_000), `Expires at: ${expires} (UTC; about 1h 30m remaining)`);
  }
  assert.equal(formatTempExpiry(expires, undefined, now + 4 * 3600_000), `Expires at: ${expires} (UTC; about 0m remaining)`);
});
test('detectable clock disagreement or invalid local clock never invents a longer lifetime', () => {
  const expires = '2026-09-28T21:00:00.000Z';
  assert.equal(formatTempExpiry(expires, 10800, Date.parse('2026-09-28T11:00:00Z')), `Expires at: ${expires} (UTC)`);
  assert.equal(formatTempExpiry(expires, 10800, Number.NaN), `Expires at: ${expires} (UTC)`);
});

test('a run where no browser started is not summarised as "0 failed steps" (Haiku w2-invites, tsk_70d6db11)', () => {
  // The w2-invites journey shape: the only segment never started its browser.
  const journey = {
    passed: false, mode: 'journey', steps: [], incomplete: [], refusals: null, browser_runs: 0, cleanup_confirmed: true,
    verdict: 'FAIL — segment 1 (invitee, desktop): Browser startup or cleanup could not be confirmed. [BROWSER_STARTUP_UNAVAILABLE]',
    segments: [{ segment: 1, as: 'invitee', viewport: 'desktop', path: '/auth/magic?token=secret-token', ran: false, passed: false,
      error: { code: 'BROWSER_STARTUP_UNAVAILABLE', message: 'Browser startup or cleanup could not be confirmed. Work may still be pending; do not retry automatically.' } }],
  };
  const summary = summarizeVerifyReport(journey);
  assert.equal(summary.segments_not_started, 1);
  assert.deepEqual(summary.start_errors, ['BROWSER_STARTUP_UNAVAILABLE']);
  const line = formatVerifySummaryLine(summary);
  assert.match(line, /^Verify FAIL: no browser ran \(BROWSER_STARTUP_UNAVAILABLE\); nothing was checked, so this is not an app result\. 1 segment refused or not started/);
  assert.doesNotMatch(line, /0 failed steps/);
  assert.doesNotMatch(JSON.stringify(summary) + line, /secret-token|could not be confirmed|https?:\/\//, 'codes only: no messages or URLs');

  // One flow whose only viewport was refused.
  const flow = { ...report, passed: false, steps: [], refusals: [{ viewport: 'desktop', detail: { code: 'BROWSER_SESSION_LIMIT', status: 429, message: '10 of 10 active' } }] };
  assert.match(formatVerifySummaryLine(summarizeVerifyReport(flow)), /^Verify FAIL: no browser ran \(BROWSER_SESSION_LIMIT\); .* 1 viewport refused or not started/);

  // Some segments ran: the counts stay, and the unstarted one is named.
  const partial = { ...journey, browser_runs: 1,
    steps: [{ step: 1, viewport: 'owner #1 desktop', passed: false, name: 'expect #ok', error: 'expect failed', duration_ms: 40 }],
    segments: [{ segment: 1, as: 'owner', viewport: 'desktop', ran: true, passed: false }, journey.segments[0]] };
  assert.equal(formatVerifySummaryLine(summarizeVerifyReport(partial)),
    'Verify FAIL: 1 failed steps, 0 refusals, 1 segment not started (BROWSER_STARTUP_UNAVAILABLE), 40 ms in steps; full report saved to --out destination');

  // A pass reads exactly as before.
  const pass = { ...report, passed: true, steps: [{ step: 1, viewport: 'desktop', passed: true, name: 'Save', duration_ms: 12 }] };
  assert.equal(formatVerifySummaryLine(summarizeVerifyReport(pass)), 'Verify PASS: 0 failed steps, 0 refusals, 12 ms in steps; full report saved to --out destination');
});

test('an existing --out names the next free report path; reports are still never overwritten (Haiku w2/w3, tsk_70d6db11)', () => {
  const taken = new Set(['flows/run2-report.json', 'flows/run2-report-2.json']);
  const exists = (p) => taken.has(p);
  assert.equal(nextFreeOutPath('flows/run2-report.json', exists), 'flows/run2-report-3.json', 'skips names already taken');
  assert.equal(nextFreeOutPath('flows/run2-report-2.json', exists), 'flows/run2-report-3.json', 'a numbered name counts on');
  assert.equal(nextFreeOutPath('report', () => false), 'report-2', 'no extension');
  assert.equal(nextFreeOutPath('a/b.c/rep', () => false), 'a/b.c/rep-2', 'a dot in a directory is not an extension');
  assert.equal(outExistsMessage('flows/run2-report.json', exists),
    '--out file already exists (flows/run2-report.json); reports are never overwritten. Rerun with a new path, for example --out flows/run2-report-3.json, or move the old report first.');
});
