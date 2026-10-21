// Verify reports and their text mask the credential-bearing parts of URLs the
// caller or the browser supplied (tsk_70d6db11): URL userinfo, the value of a
// listed credential parameter (the platform log-sanitize list) in the query or
// fragment, also when its name is percent-encoded or it is nested encoded in
// another parameter, and credential-shaped path segments. Covered fields:
// segment path/final_url, viewport final_url, target, goto labels. A Haiku round
// on 2026-10-21 kept /auth/magic?token=… in a journey's segments[].path (CLI
// 0.37.60). The browser still navigates to the original URL.
import test from 'node:test';
import assert from 'node:assert/strict';

const { createVerifyJourneyRun, formatVerifyJourneyReport, formatVerifyReport, normalizeVerifyJourney, normalizeVerifyFlow, runVerification } = await import('../dist/commands/verify.js');

const SECRETS = ['MAGIC_SECRET_1', 'MAGIC_SECRET_2', 'FINAL_SECRET_3', 'NESTED_SECRET_4', 'TARGET_SECRET_5', 'USERINFO_SECRET_6', 'FRAGMENT_SECRET_7', 'ENCODED_SECRET_8', 'ENCODED_SECRET_9', 'HASHQ_SECRET_10'];
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

test('journey: listed credential query values are masked in the report and its text; the browser gets the original', async () => {
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

test('boundary: userinfo, fragment credentials and percent-encoded names are masked; the browser gets the original', async () => {
  const cases = [
    { path: '/cb#access_token=FRAGMENT_SECRET_7&token_type=bearer&state=s1', want: '/cb#access_token=<redacted>&token_type=bearer&state=s1' },
    { path: '/m?%74oken=ENCODED_SECRET_8&acc%65ss_token=ENCODED_SECRET_9&page=2', want: '/m?%74oken=<redacted>&acc%65ss_token=<redacted>&page=2' },
    { path: '/app#/route?token=HASHQ_SECRET_10&tab=1', want: '/app#/route?token=<redacted>&tab=1' },
  ];
  for (const { path, want } of cases) {
    const client = fakeClient(() => report({ final_url: 'https://alice:USERINFO_SECRET_6@app.somewhere.site/x?ok=1#top' }));
    const result = await createVerifyJourneyRun({ project_id: 'app' }, normalizeVerifyJourney({ actors: { a: {} }, journey: [{ as: 'a', path, actions: [{ click: '#x' }] }] }), client, { runId: 'r3' }).run();
    assert.equal(result.segments[0].path, want);
    assert.equal(result.segments[0].final_url, 'https://<redacted>@app.somewhere.site/x?ok=1#top');
    assert.deepEqual(leaks(JSON.stringify(result) + formatVerifyJourneyReport(result)), []);
    assert.equal(client.runs()[0].body.url, path, 'navigation uses the original');
  }
  const url = 'https://alice:USERINFO_SECRET_6@app.somewhere.site/x';
  const client = fakeClient(() => report({ final_url: url }));
  const single = await runVerification({ url }, normalizeVerifyFlow({ actions: [{ click: '#go' }] }), client);
  assert.equal(single.target, 'https://<redacted>@app.somewhere.site/x');
  assert.ok(client.runs().every((c) => c.body.url === url), 'navigation uses the original');
});

test('LEGIT: ordinary URLs and app data are not masked', async () => {
  for (const path of ['/club?page=2&q=hello', '/keyboard?monkey=1&keys=3&tokens=4', '/redeem?code=PROMO-10&invite_id=inv_1', '/a/b#token-anchor', '/docs#section-2', '/cb#token_type=bearer&state=abc', '/members#tab=members', '/u/@alice?email=a@b.example', '/x?%74ab=1']) {
    const client = fakeClient(() => report({ final_url: `https://app.somewhere.site${path}` }));
    const result = await createVerifyJourneyRun({ project_id: 'app' }, normalizeVerifyJourney({ actors: { a: {} }, journey: [{ as: 'a', path, actions: [{ click: '#x' }] }] }), client, { runId: 'r2' }).run();
    assert.equal(result.segments[0].path, path, path);
    assert.equal(result.segments[0].final_url, `https://app.somewhere.site${path}`, path);
  }
});
