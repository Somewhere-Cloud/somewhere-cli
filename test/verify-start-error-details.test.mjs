import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeVerifyReport, formatVerifySummaryLine } from '../dist/commands/verify.js';

// tsk_da2dba3d slice 1 (ranking episode 1A): the platform already returns the refusal's structured
// detail; the CLI summary forwarded only codes, so the agent saw start_errors:["VALIDATION_ERROR"]
// and nothing to act on. The summary now carries shape-checked { code, status, path, limit_ms } and
// names it, but never the message, which can quote selectors, values or URLs.
const SECRET_MESSAGE = 'action 6: wait 90000 ms is longer than the 45000 ms limit near button[data-x="hunter2-CANARY"] at https://app.example/p?token=CANARYq';
const flowReport = (detail) => ({ passed: false, steps: [], refusals: [{ viewport: 'desktop', detail }], incomplete: [], lifecycle: [] });

test('episode 1A: a refused 90000 ms wait names its path and limit, not its message', () => {
  const summary = summarizeVerifyReport(flowReport({ code: 'VALIDATION_ERROR', status: 400, message: SECRET_MESSAGE, data: { invalid: { path: 'actions[6].wait', limit_ms: 45000 } } }));
  assert.deepEqual(summary.start_error_details, [{ code: 'VALIDATION_ERROR', status: 400, path: 'actions[6].wait', limit_ms: 45000, refusal_index: 0 }]);
  const line = formatVerifySummaryLine(summary);
  assert.match(line, /^Verify FAIL: no browser ran \(VALIDATION_ERROR\)/);
  assert.match(line, /VALIDATION_ERROR at actions\[6\]\.wait \(max 45000 ms\), fix that field before running again; read refusals\[0\]\.detail\.message in your --out report/);
  for (const text of [line, JSON.stringify(summary)]) assert.doesNotMatch(text, /CANARY|hunter2|https?:|button\[|90000 ms is longer/);
});

test('the detail may sit on the refusal detail itself (MCP/route shapes) and still passes the same checks', () => {
  const summary = summarizeVerifyReport(flowReport({ code: 'VALIDATION_ERROR', status: 400, invalid: { path: 'steps[2]' } }));
  assert.deepEqual(summary.start_error_details, [{ code: 'VALIDATION_ERROR', status: 400, path: 'steps[2]', refusal_index: 0 }]);
  assert.match(formatVerifySummaryLine(summary), /VALIDATION_ERROR at steps\[2\], fix that field/);
});

test('anything outside the agreed shapes is dropped, so hostile or free-text detail never reaches stdout', () => {
  for (const invalid of [
    { path: 'actions[0].wait; rm -rf ~' }, { path: 'selector:#login' }, { path: 'actions[0].Wait' }, { path: 'actions[99999].wait' },
    { path: 'actions[1].wait', limit_ms: '45000' }, { path: 'actions[1].wait', limit_ms: -5 }, { path: 'https://x/?token=CANARYq' }, 'actions[0].wait',
  ]) {
    const summary = summarizeVerifyReport(flowReport({ code: 'VALIDATION_ERROR', status: 400, message: SECRET_MESSAGE, data: { invalid } }));
    const kept = summary.start_error_details ?? [];
    for (const d of kept) {
      assert.match(d.path, /^(actions|steps)\[\d{1,4}\](\.[a-z_]{1,32})?$/);
      assert.ok(d.limit_ms === undefined || (Number.isSafeInteger(d.limit_ms) && d.limit_ms > 0));
    }
    assert.doesNotMatch(formatVerifySummaryLine(summary) + JSON.stringify(summary), /CANARY|rm -rf|selector:|https?:/);
  }
  const badCode = summarizeVerifyReport(flowReport({ code: 'validation error; $(id)', status: 400, data: { invalid: { path: 'actions[0].wait' } } }));
  assert.equal(badCode.start_error_details, undefined);
});

test('a passing run and a refusal without structured detail keep today\'s summary unchanged', () => {
  const pass = summarizeVerifyReport({ passed: true, steps: [{ passed: true, duration_ms: 10 }], refusals: [], incomplete: [], lifecycle: [] });
  assert.equal(pass.start_error_details, undefined);
  assert.match(formatVerifySummaryLine(pass), /^Verify PASS: 0 failed steps/);
  const codeOnly = summarizeVerifyReport(flowReport({ code: 'BROWSER_DAILY_LIMIT', status: 429, message: SECRET_MESSAGE }));
  assert.equal(codeOnly.start_error_details, undefined);
  assert.match(formatVerifySummaryLine(codeOnly), /no browser ran \(BROWSER_DAILY_LIMIT\); nothing was checked/);
});
