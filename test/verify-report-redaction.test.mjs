// A verify report, summary or error never carries a sign-in credential from a
// URL the caller or the browser supplied (tsk_70d6db11). A Haiku round on
// 2026-10-21 kept full /auth/magic?token=… links in a journey's segments[].path.
// The browser still navigates to the original URL; only what is emitted is masked.
import test from 'node:test';
import assert from 'node:assert/strict';

const { createVerifyJourneyRun, formatVerifyJourneyReport, formatVerifyReport, normalizeVerifyJourney, normalizeVerifyFlow, runVerification } = await import('../dist/commands/verify.js');

const SECRETS = ['MAGIC_SECRET_1', 'MAGIC_SECRET_2', 'FINAL_SECRET_3', 'NESTED_SECRET_4', 'TARGET_SECRET_5'];
const report = (overrides = {}) => ({
  passed: true, final_url: 'https://app.somewhere.site/club', console_errors: [], page_errors: [], failed_requests: [], request_expectations: [],
  steps: [{ step: 0, action: 'click', ok: true }], screenshots: [{ label: 'page', fs_path: '/_browser_tests/r/page.jpg', url: 'https://api.test/s/page.jpg' }], session_expires_at: '2026-10-21T12:03:00.000Z', ...overrides,
});
function fakeClient(answer) {
  const calls = [];
  return {
    calls, runs: () => calls.filter((c) => c.body.close !== true),
    async call(_m, _p, body) { calls.push({ body: structuredClone(body) }); return body.close === true ? { closed: true } : answer(body, calls.filter((c) => c.body.close !== true).length); },
  };
}
const leaks = (value) => SECRETS.filter((s) => value.includes(s));

test('journey: credential query values are masked in the report and its text; the browser gets the original', async () => {
  const magic = '/auth/magic?token=MAGIC_SECRET_1&redirect_uri=https%3A%2F%2Fapp.somewhere.site%2F%3Finvite_id%3Dinv_880b%26token%3DNESTED_SECRET_4';
  const journey = normalizeVerifyJourney({
    actors: { alice: {}, bob: {} },
    journey: [
      { as: 'alice', path: magic, actions: [{ click: '#accept' }] },
      { as: 'bob', path: '/club?page=2&invite_id=inv_9#top', actions: [{ click: '#a' }] },
      { as: 'alice', path: '/auth/magic?token=MAGIC_SECRET_2', actions: [{ click: '#b' }] },
    ],
  });
  const client = fakeClient((_b, n) => report(n === 1 ? { final_url: 'https://app.somewhere.site/welcome?token=FINAL_SECRET_3&tab=members' } : {}));
  const result = await createVerifyJourneyRun({ project_id: 'app' }, journey, client, { runId: 'r1' }).run();

  // FIRES: nothing emitted holds a credential.
  assert.deepEqual(leaks(JSON.stringify(result)), []);
  assert.deepEqual(leaks(formatVerifyJourneyReport(result)), []);
  // Useful: the path, ordinary query, app data and fragment stay readable.
  assert.equal(result.segments[0].path, '/auth/magic?token=<redacted>&redirect_uri=https%3A%2F%2Fapp.somewhere.site%2F%3Finvite_id%3Dinv_880b%26token%3D<redacted>');
  assert.equal(result.segments[0].final_url, 'https://app.somewhere.site/welcome?token=<redacted>&tab=members');
  assert.equal(result.segments[1].path, '/club?page=2&invite_id=inv_9#top');
  assert.equal(result.segments[2].path, '/auth/magic?token=<redacted>');
  // Navigation preserved: the browser receives the original URLs.
  const bodies = client.runs().map((c) => c.body);
  assert.equal(bodies[0].url, magic);
  assert.deepEqual(bodies[2].actions[0], { goto: '/auth/magic?token=MAGIC_SECRET_2' });
});

test('single run: target and final_url are masked in the report; the browser gets the original', async () => {
  const url = 'https://app.somewhere.site/auth/magic?token=TARGET_SECRET_5&next=%2Fhome';
  const client = fakeClient(() => report({ final_url: url }));
  const result = await runVerification({ url }, normalizeVerifyFlow({ actions: [{ click: '#go' }] }), client);
  assert.deepEqual(leaks(JSON.stringify(result)), []);
  assert.deepEqual(leaks(formatVerifyReport(result)), []);
  assert.equal(result.target, 'https://app.somewhere.site/auth/magic?token=<redacted>&next=%2Fhome');
  assert.ok(result.viewports.every((v) => v.final_url === result.target));
  assert.ok(client.runs().every((c) => c.body.url === url), 'navigation uses the original URL');
});

test('LEGIT: ordinary URLs and app data are not masked', async () => {
  for (const path of ['/club?page=2&q=hello', '/keyboard?monkey=1&keys=3&tokens=4', '/redeem?code=PROMO-10&invite_id=inv_1', '/a/b#token-anchor']) {
    const client = fakeClient(() => report({ final_url: `https://app.somewhere.site${path}` }));
    const result = await createVerifyJourneyRun({ project_id: 'app' }, normalizeVerifyJourney({ actors: { a: {} }, journey: [{ as: 'a', path, actions: [{ click: '#x' }] }] }), client, { runId: 'r2' }).run();
    assert.equal(result.segments[0].path, path, path);
    assert.equal(result.segments[0].final_url, `https://app.somewhere.site${path}`, path);
  }
});
