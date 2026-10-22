// Multi-user verify journeys (tsk_f49ccbb75f994f1fb5179198087d24de): one run,
// several isolated signed-in browsers, bounded existing browser calls, and every
// actor browser closed however the run ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  VERIFY_JOURNEY_LIMITS,
  createVerifyJourneyRun,
  formatVerifyJourneyReport,
  normalizeVerifyFlow,
  normalizeVerifyJourney,
  verifyFlowSchema,
} = await import('../dist/commands/verify.js');
const { normalizeBrowserActions } = await import('../dist/lib/browser-actions.js');
const { CliApiError } = await import('../dist/lib/client.js');

const SECRET_COOKIE = 'cookie-secret-8f2a';
const SECRET_STORAGE = 'storage-secret-19cd';

function report(overrides = {}) {
  return {
    passed: true,
    final_url: 'https://club.somewhere.site/club',
    console_errors: [],
    page_errors: [],
    failed_requests: [],
    request_expectations: [],
    steps: [{ step: 0, action: 'click', ok: true }],
    screenshots: [{ label: 'page', fs_path: '/_browser_tests/r/page.jpg', url: 'https://api.test/s/page.jpg' }],
    accessibility_layout: 'layout: no horizontal overflow; 0 small tap targets',
    ...overrides,
  };
}

/** A fake platform: records every call; `answer(body, n)` decides each run. */
function fakeClient(answer = () => report()) {
  const calls = [];
  return {
    calls,
    runs: () => calls.filter((call) => call.body.close !== true),
    closes: () => calls.filter((call) => call.body.close === true),
    async call(method, path, body, _query, opts) {
      assert.equal(method, 'POST');
      assert.equal(path, '/browser/test');
      calls.push({ body: structuredClone(body), opts });
      if (body.close === true) return { session_id: body.session_id, closed: true };
      return answer(body, calls.filter((call) => call.body.close !== true).length);
    },
  };
}

const bookclub = {
  actors: {
    alice: { cookies: [{ name: 'pref', value: SECRET_COOKIE }] },
    bob: { auth: { user_id: 'usr_bob' }, local_storage: { theme: SECRET_STORAGE } },
  },
  journey: [
    { as: 'alice', path: '/signup', actions: [{ fill: '#email', value: 'alice@example.test' }, { click: '#create' }] },
    { as: 'bob', path: '/club', actions: [{ click: '#vote-1' }], expect_requests: [{ path: '/api/vote', status: 200 }] },
    { as: 'alice', path: '/club', viewport: 'mobile', actions: [{ eval: "fetch('/api/state').then(r => r.status)" }] },
    { as: 'bob', actions: [{ click: '#close' }], expect_requests: [{ path: '/api/close', status: 403 }] },
  ],
};

test('a legitimate two-user journey runs in order, each actor in its own continued browser', async () => {
  const journey = normalizeVerifyJourney(bookclub);
  const client = fakeClient();
  const run = createVerifyJourneyRun({ project_id: 'club' }, journey, client, { runId: 'r1' });
  const result = await run.run();
  assert.equal(result.passed, true, result.verdict);
  assert.match(result.verdict, /^PASS — 4 segments by 2 users \(alice, bob\)/);
  assert.equal(result.mode, 'journey');
  assert.equal(result.browser_runs, 4);

  const runs = client.runs().map((call) => call.body);
  assert.deepEqual(runs.map((body) => body.session_id), ['vf-r1-alice', 'vf-r1-bob', 'vf-r1-alice', 'vf-r1-bob']);
  assert.ok(runs.every((body) => body.project_id === 'club'), 'every actor call names the project');
  assert.deepEqual(runs.map((body) => body.url), ['/signup', '/club', undefined, undefined],
    'an actor\'s first segment starts at its path; a continued actor is not re-navigated by url');
  assert.deepEqual(runs[2].actions[0], { goto: '/club' }, 'a continued actor moves with a leading goto');
  assert.equal(runs[3].actions.length, 1, 'no goto without a path');
  assert.deepEqual(runs.map((body) => body.viewport), ['desktop', 'desktop', 'mobile', 'desktop']);
  assert.ok(runs.every((body) => body.capture_after === true && body.inline === false));
  assert.deepEqual(runs[3].expect_requests, [{ path: '/api/close', status: 403 }]);

  // Cleanup on success: exactly the two opened browsers are closed.
  assert.deepEqual(client.closes().map((call) => call.body), [{ project_id: 'club', session_id: 'vf-r1-alice', close: true }, { project_id: 'club', session_id: 'vf-r1-bob', close: true }]);
  assert.deepEqual(result.cleanup, [{ actor: 'alice', status: 'closed' }, { actor: 'bob', status: 'closed' }]);
  assert.equal(result.cleanup_confirmed, true);
  assert.equal(result.limits.cleanup_budget_ms, 20_000, 'the cleanup budget is reported separately from the journey budget');
  assert.ok(result.cleanup_ms >= 0);
  assert.equal(result.layout.length, 4, 'the overflow/tap-target line is reported for every segment');
  assert.match(result.layout[2].viewport, /alice #3 mobile/);
});

test('cleanup targets the actor project; an unscoped close cannot clear its live slot', async () => {
  const live = new Map([
    ['club', new Set(['vf-scope-alice'])],
    ['other', new Set(['vf-scope-alice'])],
  ]);
  const calls = [];
  const client = { async call(_method, _path, body) {
    calls.push(structuredClone(body));
    if (body.close === true || !body.project_id) {
      if (body.project_id !== 'club' || body.close !== true) return { closed: false };
      return { closed: live.get(body.project_id).delete(body.session_id) };
    }
    return report();
  } };
  const journey = normalizeVerifyJourney({ actors: { alice: {} }, journey: [{ as: 'alice', actions: [{ click: '#ready' }] }] });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, journey, client, { runId: 'scope' }).run();
  assert.deepEqual(calls.at(-1), { project_id: 'club', session_id: 'vf-scope-alice', close: true });
  assert.equal(live.get('club').size, 0, 'the project-scoped session slot was actually removed');
  assert.equal(live.get('other').size, 1, 'a same-named session in another project remains untouched');
  assert.deepEqual(result.cleanup, [{ actor: 'alice', status: 'closed' }]);
  assert.equal(result.cleanup_confirmed, true);
});

test('identity isolation: seeds reach only their own actor, only on its first call, and never the report', async () => {
  const client = fakeClient();
  const run = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r2' });
  const result = await run.run();
  const [alice1, bob1, alice2, bob2] = client.runs().map((call) => call.body);
  assert.deepEqual(alice1.cookies, [{ name: 'pref', value: SECRET_COOKIE }]);
  assert.equal('auth' in alice1 || 'local_storage' in alice1, false, 'alice never receives bob\'s identity');
  assert.deepEqual(bob1.auth, { user_id: 'usr_bob' });
  assert.deepEqual(bob1.local_storage, { theme: SECRET_STORAGE });
  assert.equal('cookies' in bob1, false, 'bob never receives alice\'s cookie');
  for (const body of [alice2, bob2]) {
    for (const field of ['auth', 'local_storage', 'cookies', 'headers']) {
      assert.equal(field in body, false, `a continued actor is not re-seeded (${field})`);
    }
  }
  assert.notEqual(alice1.session_id, bob1.session_id, 'separate browsers');
  const printed = JSON.stringify(result) + formatVerifyJourneyReport(result).join('\n');
  assert.ok(!printed.includes(SECRET_COOKIE) && !printed.includes(SECRET_STORAGE), 'seed values never appear in output');

  // A second run never resumes the first run's browsers.
  const again = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), fakeClient());
  assert.notEqual(again.sessions.alice, run.sessions.alice);
  assert.match(again.sessions.alice, /^vf-[0-9a-f]{8}-alice$/);
});

test('a failing segment stops the journey truthfully, and every opened browser is still closed', async () => {
  const client = fakeClient((_body, n) => n === 2
    ? report({ passed: false, steps: [{ step: 0, action: 'click', ok: false, error: 'selector #vote-1 did not match' }] })
    : report());
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r3' }).run();
  assert.equal(result.passed, false);
  assert.match(result.verdict, /^FAIL — segment 2 — step 1 \(click #vote-1\) failed at bob #2 desktop: selector #vote-1 did not match/);
  assert.equal(client.runs().length, 2, 'later segments do not run after a failure');
  assert.deepEqual(result.segments.map((s) => [s.segment, s.ran, s.passed]), [[1, true, true], [2, true, false], [3, false, false], [4, false, false]]);
  assert.deepEqual(client.closes().map((call) => call.body.session_id), ['vf-r3-alice', 'vf-r3-bob']);
  assert.match(formatVerifyJourneyReport(result).join('\n'), /segment 3 .*not run/);
});

test('an intended 403 passes only when it is actually seen', async () => {
  const seen = fakeClient((body) => report({
    request_expectations: body.expect_requests.map((item) => ({ ...item, ok: true })),
  }));
  assert.equal((await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), seen).run()).passed, true);
  const missing = fakeClient((body) => report({
    request_expectations: body.expect_requests.map((item) => ({ ...item, ok: item.status !== 403, ...(item.status === 403 ? { error: 'Expected /api/close to return 403; saw 200.' } : {}) })),
  }));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), missing).run();
  assert.equal(result.passed, false);
  assert.match(result.verdict, /segment 4 — expected request \/api\/close:403 was not observed at bob #4 desktop/);
});

test('a continued actor whose browser was replaced fails as a different person; a first call note does not', async () => {
  const client = fakeClient((_body, n) => report(n === 1 || n === 3 ? { session_note: 'session expired, started fresh' } : {}));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r4' }).run();
  assert.equal(result.passed, false);
  assert.match(result.verdict, /^FAIL — segment 3 \(alice, mobile\): alice's browser ended between segments/);
  assert.match(result.verdict, /\[VERIFY_ACTOR_SESSION_ENDED\]$/);
  assert.equal(client.runs().length, 3);
  assert.equal(client.closes().length, 2);
});

test('platform refusals stop the run with their code and still clean up', async () => {
  for (const [code, message] of [
    ['BROWSER_ORIGIN_NOT_AUTHORIZED', 'Driving this page only works on an address one of your own projects serves.'],
    ['BROWSER_SESSION_LIMIT', 'You already have 3 live browser sessions (a, b, c). Close one.'],
    ['CLAIM_ACCOUNT_REQUIRED', 'Persistent browser sessions require a claimed account.'],
  ]) {
    const client = fakeClient((_body, n) => { if (n === 2) throw new CliApiError(code, message, 403); return report(); });
    const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r5' }).run();
    assert.equal(result.passed, false, code);
    assert.ok(result.verdict.startsWith(`FAIL — segment 2 (bob, desktop): ${message}`), result.verdict);
    assert.ok(result.verdict.endsWith(`[${code}]`));
    assert.equal(result.segments[1].ran, false, 'a refusal is not counted as a browser run');
    assert.equal(result.browser_runs, 1);
    assert.deepEqual(client.closes().map((call) => call.body.session_id), ['vf-r5-alice', 'vf-r5-bob']);
  }
});

test('a transport failure still closes the browsers; a close failure is reported, not hidden', async () => {
  const client = fakeClient((_body, n) => { if (n === 2) throw new Error('socket hang up'); return report(); });
  client.call = ((original) => async (method, path, body, query, opts) => {
    if (body.close === true && body.session_id.endsWith('bob')) {
      client.calls.push({ body: structuredClone(body), opts });
      throw new CliApiError('AUTHORITY_UNAVAILABLE', 'try again', 503);
    }
    return original(method, path, body, query, opts);
  })(client.call.bind(client));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r6' }).run();
  assert.equal(result.passed, false);
  assert.match(result.verdict, /socket hang up \[VERIFY_SEGMENT_FAILED\][\s\S]*INCOMPLETE/);
  assert.deepEqual(result.cleanup[0], { actor: 'alice', status: 'closed' });
  assert.equal(result.cleanup[1].status, 'unconfirmed');
  assert.match(result.cleanup[1].reason, /close failed \(AUTHORITY_UNAVAILABLE\); the platform closes an idle browser within 5 minutes/);
  assert.equal(result.cleanup_confirmed, false, 'an unconfirmed close is never reported as clean');
  assert.match(formatVerifyJourneyReport(result).join('\n'), /bob unconfirmed[\s\S]*bob: close failed \(AUTHORITY_UNAVAILABLE\)/);
});

test('the journey deadline stops before the next segment and cleans up', async () => {
  let clock = 0;
  const client = fakeClient((_body, n) => { if (n === 2) clock += VERIFY_JOURNEY_LIMITS.deadline_ms + 1; return report(); });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r7', now: () => clock }).run();
  assert.equal(result.passed, false);
  assert.match(result.verdict, /^FAIL — segment 3 \(alice, mobile\): The journey reached its 10-minute limit\. \[VERIFY_JOURNEY_DEADLINE\]$/);
  assert.equal(client.runs().length, 2);
  assert.equal(client.closes().length, 2);
});

test('closeAll is idempotent and only closes browsers the run opened', async () => {
  const client = fakeClient();
  const run = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'r8' });
  assert.deepEqual((await run.closeAll()).cleanup, [], 'nothing opened, nothing closed');
  assert.equal(client.calls.length, 0);
  await assert.doesNotReject(run.run(), 'a closed run still returns a report');
  assert.equal(client.runs().length, 0, 'once cleanup has started, no segment starts');
  const client2 = fakeClient((_body, n) => { if (n === 1) throw new CliApiError('BROWSER_SESSION_LIMIT', 'limit', 429); return report(); });
  const run2 = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client2, { runId: 'r9' });
  await run2.run();
  await run2.closeAll();
  assert.deepEqual(client2.closes().map((call) => call.body.session_id), ['vf-r9-alice'], 'bob never started, so only alice is closed, once');
});

test('multi-user runs need the project and a deployed app, refused before any browser', async () => {
  const client = fakeClient();
  await assert.rejects(createVerifyJourneyRun({ url: 'https://club.somewhere.site/' }, normalizeVerifyJourney(bookclub), client).run(), /needs --project/);
  await assert.rejects(createVerifyJourneyRun({ project_id: 'club', url: 'http://127.0.0.1:5173/' }, normalizeVerifyJourney(bookclub), client).run(), /deployed app/);
  assert.equal(client.calls.length, 0);
});

test('limits and shape are enforced before any browser starts, naming the limit and the fix', () => {
  const four = { actors: { a: {}, b: {}, c: {}, d: {} }, journey: [{ as: 'a' }, { as: 'b' }, { as: 'c' }, { as: 'd' }] };
  assert.throws(() => normalizeVerifyJourney(four), /1 to 3 actors/);
  const many = { actors: { a: {} }, journey: Array.from({ length: 13 }, () => ({ as: 'a' })) };
  assert.throws(() => normalizeVerifyJourney(many), /13 segments; the limit is 12/);
  const thirty = Array.from({ length: 30 }, () => ({ click: '#x' }));
  assert.doesNotThrow(() => normalizeVerifyJourney({ actors: { a: {} }, journey: [{ as: 'a', path: '/', actions: thirty }] }),
    'an actor\'s first path is the start url, not an extra action');
  assert.throws(() => normalizeVerifyJourney({ actors: { a: {} }, journey: [{ as: 'a' }, { as: 'a', path: '/x', actions: thirty }] }),
    /31 actions \(including the goto for its path\); the limit per segment is 30/);
  const total = { actors: { a: {} }, journey: Array.from({ length: 5 }, () => ({ as: 'a', actions: thirty })) };
  assert.throws(() => normalizeVerifyJourney(total), /150 actions in total; the limit is 120/);
  assert.throws(() => normalizeVerifyJourney({ actors: { a: {} }, journey: [{ as: 'b' }] }), /must name one of the actors \(a\)/);
  assert.throws(() => normalizeVerifyJourney({ actors: { a: {}, b: {} }, journey: [{ as: 'a' }] }), /b is declared but never used/);
  assert.throws(() => normalizeVerifyJourney({ actors: { Alice: {} }, journey: [{ as: 'Alice' }] }), /actor name "Alice"/);
  for (const bad of ['//evil.test/x', 'https://evil.test/', 'club', '/a b']) {
    assert.throws(() => normalizeVerifyJourney({ actors: { a: {} }, journey: [{ as: 'a', path: bad }] }), /path must be a path on this app/);
  }
  assert.throws(() => normalizeVerifyJourney({ ...bookclub, viewports: ['mobile'] }), /only "actors" and "journey" \(found viewports\)/);
  assert.throws(() => normalizeVerifyJourney({ actors: { a: { password: 'x' } }, journey: [{ as: 'a' }] }), /actors\.a has unsupported field: password/);
  assert.throws(() => normalizeVerifyJourney({ actors: { a: { local_storage: { k: 'x'.repeat(9000) } } }, journey: [{ as: 'a' }] }), /8 KB/);
  assert.throws(() => normalizeVerifyFlow(bookclub), /multi-user flow \(actors \+ journey\)\. Run it with `somewhere verify/,
    'deploy --verify and single-user loaders name the right command');
});

test('goto is one shared, path-only action', () => {
  assert.deepEqual(normalizeBrowserActions([{ goto: '/club' }]), { ok: true, actions: [{ goto: '/club' }] });
  for (const bad of ['//evil.test', 'https://evil.test', 'club', '/a\\b', 7]) {
    const out = normalizeBrowserActions([{ goto: bad }]);
    assert.equal(out.ok, false);
    assert.match(out.error, /goto must be a path on this app/);
  }
});

function cli(args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sw-journey-home-'));
  const result = spawnSync(process.execPath, [join(process.cwd(), 'dist/index.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', ...env },
  });
  rmSync(home, { recursive: true, force: true });
  return result;
}

test('--schema prints the machine-readable flow contract; --help carries a valid multi-user example', () => {
  const schema = cli(['verify', '--schema']);
  assert.equal(schema.status, 0, schema.stderr);
  const parsed = JSON.parse(schema.stdout);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(verifyFlowSchema())));
  assert.equal(parsed.oneOf.length, 2);
  assert.deepEqual(parsed['x-limits'], { ...VERIFY_JOURNEY_LIMITS });
  const [segmentSchema, groupSchema] = parsed.oneOf[1].properties.journey.items.oneOf;
  assert.ok(segmentSchema.properties.actions.items.oneOf.some((item) => item.required[0] === 'goto'));
  assert.deepEqual(groupSchema.required, ['parallel']);
  assert.deepEqual(groupSchema.properties.parallel.items, segmentSchema, 'a parallel group holds ordinary segments');
  assert.equal(groupSchema.properties.parallel.minItems, 2);
  assert.equal(groupSchema.properties.parallel.maxItems, 3);
  assert.equal(groupSchema.additionalProperties, false);

  const help = cli(['verify', '--help']);
  assert.equal(help.status, 0, help.stderr);
  const match = help.stdout.match(/Several users in one run[^\n]*\n([\s\S]*?)\nSegments run in order/);
  assert.ok(match, help.stdout);
  const example = JSON.parse(match[1].replace(/^  /gm, ''));
  assert.equal(normalizeVerifyJourney(example).journey.length, 3);
  assert.match(help.stdout, /3 actors, 12 segments,\s+30 actions per segment, 120 in total, 10 minutes/);
});

test('Ctrl-C during a journey closes every opened actor browser before exiting', async () => {
  const seen = [];
  let heldBob = null;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push(body);
      res.setHeader('Content-Type', 'application/json');
      if (body.close === true) {
        res.end(JSON.stringify({ ok: true, data: { session_id: body.session_id, closed: true } }));
        // Closing bob's browser ends his run, as on the platform: his call answers.
        if (body.session_id.endsWith('-bob') && heldBob) { const answer = heldBob; heldBob = null; setTimeout(answer, 20); }
        return;
      }
      if (seen.filter((b) => b.project_id).length === 1) { res.end(JSON.stringify({ ok: true, data: report() })); return; }
      // The second actor's segment is running when the operator presses Ctrl-C.
      heldBob = () => { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: 'BROWSER_TEST_FAILED', message: 'the browser was closed' })); };
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dir = mkdtempSync(join(tmpdir(), 'sw-journey-sigint-'));
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  writeFileSync(join(dir, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_fixture' }));
  const flowPath = join(dir, 'flow.json');
  writeFileSync(flowPath, JSON.stringify(bookclub));
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/index.js'), 'verify', '--project', 'club', '--flow', flowPath, '--json'], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let i = 0; i < 100 && seen.filter((b) => b.close !== true).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.filter((b) => b.close !== true).length, 2, `the second segment started (${stderr})`);
  child.kill('SIGINT');
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
  server.closeAllConnections?.();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 130);
  const closes = seen.filter((b) => b.close === true).map((b) => b.session_id).sort();
  assert.equal(closes.length, 3, 'both opened browsers were closed, bob again after his call ended');
  assert.ok(closes[0].endsWith('-alice') && closes[1].endsWith('-bob') && closes[2].endsWith('-bob'));
  assert.equal(seen.filter((b) => b.close !== true).length, 2, 'no segment started after Ctrl-C');
  assert.match(stderr, /alice closed, bob (?:already )?closed/);
});

// ── Lifecycle: stop state, in-flight work, bounded concurrent cleanup ─────────

/** A fake platform whose segment answers and close delays the test controls. */
function controllableClient({ closeDelayMs = 0, closeFails = () => false, segment = () => report() } = {}) {
  const events = [];
  const held = [];
  const client = {
    events,
    held,
    runs: () => events.filter((e) => e.type === 'segment'),
    closes: (actor) => events.filter((e) => e.type === 'close-start' && (!actor || e.session.endsWith(`-${actor}`))),
    async call(_method, _path, body, _query, opts) {
      if (body.close === true) {
        events.push({ type: 'close-start', session: body.session_id, at: Date.now() });
        await new Promise((r) => setTimeout(r, closeDelayMs));
        events.push({ type: 'close-end', session: body.session_id, at: Date.now() });
        if (closeFails(body.session_id)) throw new CliApiError('AUTHORITY_UNAVAILABLE', 'try again', 503);
        return { session_id: body.session_id, closed: true };
      }
      const n = client.runs().length + 1;
      events.push({ type: 'segment', session: body.session_id, n, timeoutMs: opts?.timeoutMs, at: Date.now() });
      return segment(body, n, opts, held);
    },
  };
  return client;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function until(predicate, ms = 2000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('stop is synchronous: a segment that settles during cleanup starts nothing else, and its actor is closed again after it settles', async () => {
  const bobCall = deferred();
  const client = controllableClient({
    closeDelayMs: 20,
    segment: (_body, n) => (n === 2 ? bobCall.promise : report()),
  });
  const journeyRun = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'l1' });
  const running = journeyRun.run();
  await until(() => client.runs().length === 2);
  journeyRun.stop('VERIFY_INTERRUPTED', 'Stopped by SIGTERM.');
  const cleaning = journeyRun.closeAll();
  await until(() => client.closes().length === 2);
  bobCall.resolve(report());
  const bobSettledAt = Date.now();
  const { cleanup } = await cleaning;
  const result = await running;
  assert.equal(client.runs().length, 2, 'the segment that settled during cleanup did not start segment 3');
  assert.deepEqual(client.closes('alice').length, 1);
  const bobCloses = client.closes('bob');
  assert.equal(bobCloses.length, 2, 'bob is closed once at stop and once after his call settled');
  assert.ok(bobCloses[1].at >= bobSettledAt, 'the second close follows the settlement');
  assert.deepEqual(cleanup, [{ actor: 'alice', status: 'closed' }, { actor: 'bob', status: 'closed' }]);
  assert.equal(result.passed, false);
  assert.equal(result.segments[1].ran, true, 'the in-flight segment is reported as run');
  assert.deepEqual(result.segments[2].error, { code: 'VERIFY_INTERRUPTED', message: 'Stopped by SIGTERM.' });
  assert.match(result.verdict, /^FAIL — segment 3 \(alice, mobile\): Stopped by SIGTERM\. \[VERIFY_INTERRUPTED\]$/);
});

test('cleanup closes every opened browser concurrently under one budget', async () => {
  const client = controllableClient({ closeDelayMs: 150 });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'l2' }).run();
  const starts = client.events.filter((e) => e.type === 'close-start');
  const firstEnd = client.events.find((e) => e.type === 'close-end');
  assert.equal(starts.length, 2);
  assert.ok(starts.every((e) => e.at <= firstEnd.at), 'both closes were in flight together, not one after another');
  assert.ok(result.cleanup_ms < 280, `two 150 ms closes took ${result.cleanup_ms} ms`);
});

test('a call still running when the cleanup budget runs out is reported unconfirmed, and cleanup stays inside its budget', async () => {
  const client = controllableClient({ segment: (_body, n) => (n === 2 ? new Promise(() => {}) : report()) });
  const journeyRun = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'l3', cleanupBudgetMs: 300 });
  void journeyRun.run();
  await until(() => client.runs().length === 2);
  journeyRun.stop('VERIFY_INTERRUPTED', 'Stopped by SIGTERM.');
  const startedAt = Date.now();
  const { cleanup, cleanup_ms } = await journeyRun.closeAll();
  assert.ok(Date.now() - startedAt < 600, 'cleanup returned within its budget');
  assert.ok(cleanup_ms <= 400);
  assert.deepEqual(cleanup[0], { actor: 'alice', status: 'closed' });
  assert.equal(cleanup[1].status, 'unconfirmed');
  assert.match(cleanup[1].reason, /still running when cleanup ran out of time; the platform closes an idle browser within 5 minutes/);
  assert.equal(client.runs().length, 2);
});

test('each segment asks for an execution cap that fits the remaining journey; a budget-cut wait stops as the deadline and stays unconfirmed', async () => {
  let clock = 0;
  const client = controllableClient({
    segment: (body, n, opts) => {
      if (n === 1) {
        assert.equal(body.budget_ms, 180_000, 'a segment asks for the 180 s execution cap');
        clock = VERIFY_JOURNEY_LIMITS.deadline_ms - 60_000;
        return report();
      }
      assert.equal(body.budget_ms, 15_000, 'the cap shrinks so cap + transport headroom ends at the journey deadline');
      assert.equal(opts.timeoutMs, 60_000, 'the wait is the cap plus 45 s of headroom');
      throw new CliApiError('TIMEOUT', 'No response from POST /browser/test after 60s.', 0);
    },
  });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, {
    runId: 'l4', now: () => clock, recloseAfterAbandonedMs: 10,
  }).run();
  assert.equal(client.runs()[0].timeoutMs, VERIFY_JOURNEY_LIMITS.segment_timeout_ms);
  assert.equal(VERIFY_JOURNEY_LIMITS.segment_timeout_ms, 225_000, 'a full segment waits 180 s + 45 s');
  assert.match(result.verdict, /^INCOMPLETE — Outcome unknown/);
  assert.equal(result.segments[1].error.code, 'TIMEOUT');
  assert.equal(result.segments[1].outcome_unknown, true);
  assert.equal(client.runs().length, 2);
  assert.equal(client.closes('bob').length, 2, 'the abandoned actor is closed again later, inside the cleanup budget');
  assert.equal(result.cleanup[1].status, 'unconfirmed');
  assert.match(result.cleanup[1].reason, /got no answer, so the platform may still start it/);
  assert.equal(result.cleanup_confirmed, false);
});

test('a segment that cannot get the minimum cap plus headroom is not started', async () => {
  let clock = 0;
  const client = controllableClient({
    segment: (_body, n) => {
      if (n === 1) clock = VERIFY_JOURNEY_LIMITS.deadline_ms - 54_999;
      return report();
    },
  });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'l4b', now: () => clock }).run();
  assert.equal(client.runs().length, 1, 'no call is started that could not answer before the deadline');
  assert.match(result.verdict, /^FAIL — segment 2 \(bob, desktop\): The journey reached its 10-minute limit\. Segment 2 was not started: 54s were left, less than the 10s minimum run plus 45s for its answer\. \[VERIFY_JOURNEY_DEADLINE\]$/);
  assert.deepEqual(result.cleanup.map((item) => item.status), ['closed']);
});

test('a client timeout inside the journey budget keeps its code, and that actor is never reported closed', async () => {
  const client = controllableClient({
    segment: (_body, n) => { if (n === 2) throw new CliApiError('TIMEOUT', 'No response from POST /browser/test after 90s.', 0); return report(); },
  });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(bookclub), client, { runId: 'l5', recloseAfterAbandonedMs: 10 }).run();
  assert.match(result.verdict, /^INCOMPLETE — Outcome unknown/);
  assert.equal(result.segments[1].error.code, 'TIMEOUT');
  assert.match(result.segments[1].error.message, /after 90s/);
  assert.deepEqual(result.cleanup.map((item) => item.status), ['closed', 'unconfirmed']);
});

/** Run the real CLI against a local fake platform; the handler decides answers. */
async function cliAgainst(handler) {
  const events = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const reply = (status, payload) => {
        events.push({ type: body.close === true ? 'close-end' : 'segment-end', session: body.session_id, at: Date.now() });
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      events.push({ type: body.close === true ? 'close' : 'segment', session: body.session_id, at: Date.now() });
      handler(body, reply, events);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dir = mkdtempSync(join(tmpdir(), 'sw-journey-term-'));
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  writeFileSync(join(dir, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_fixture' }));
  const flowPath = join(dir, 'flow.json');
  writeFileSync(flowPath, JSON.stringify(bookclub));
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/index.js'), 'verify', '--project', 'club', '--flow', flowPath, '--json'], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const done = async () => {
    const code = await exited;
    server.closeAllConnections?.();
    server.close();
    rmSync(dir, { recursive: true, force: true });
    return { code, stderr };
  };
  return { child, events, done };
}

test('SIGTERM mid-journey: no new segment starts, the in-flight actor is closed again after its call settles, exit 143', async () => {
  const run = await cliAgainst((body, reply, events) => {
    if (body.close === true) {
      reply(200, { ok: true, data: { session_id: body.session_id, closed: true } });
      // Bob's held call settles only after cleanup has started.
      if (body.session_id.endsWith('-bob') && events.release) { const release = events.release; events.release = null; setTimeout(release, 150); }
      return;
    }
    const n = events.filter((e) => e.type === 'segment').length;
    if (n === 1) { reply(200, { ok: true, data: report() }); return; }
    events.release = () => reply(200, { ok: true, data: report() });
  });
  await until(() => run.events.filter((e) => e.type === 'segment').length === 2, 5000);
  run.child.kill('SIGTERM');
  const { code, stderr } = await run.done();
  assert.equal(code, 143, stderr);
  const segments = run.events.filter((e) => e.type === 'segment');
  assert.equal(segments.length, 2, 'the segment that settled during cleanup did not start another');
  const bobSettled = run.events.find((e) => e.type === 'segment-end' && e.session.endsWith('-bob'));
  const bobCloses = run.events.filter((e) => e.type === 'close' && e.session.endsWith('-bob'));
  assert.ok(bobSettled, 'bob\'s call settled during cleanup');
  assert.equal(bobCloses.length, 2);
  assert.ok(bobCloses[1].at >= bobSettled.at, 'bob was closed again after his call settled');
  assert.equal(run.events.filter((e) => e.type === 'close' && e.session.endsWith('-alice')).length, 1);
  assert.match(stderr, /browsers \(cleanup [\d.]+s of 20s budget\): alice closed, bob closed/);
});

test('SIGTERM with a failed close reports that browser as unconfirmed and still exits 143', async () => {
  const run = await cliAgainst((body, reply, events) => {
    if (body.close === true) {
      if (body.session_id.endsWith('-bob')) {
        reply(503, { ok: false, error: 'AUTHORITY_UNAVAILABLE', message: 'try again' });
        if (events.release) { const release = events.release; events.release = null; setTimeout(release, 50); }
      } else {
        reply(200, { ok: true, data: { session_id: body.session_id, closed: true } });
      }
      return;
    }
    const n = events.filter((e) => e.type === 'segment').length;
    if (n === 1) { reply(200, { ok: true, data: report() }); return; }
    events.release = () => reply(200, { ok: true, data: report() });
  });
  await until(() => run.events.filter((e) => e.type === 'segment').length === 2, 5000);
  run.child.kill('SIGTERM');
  const { code, stderr } = await run.done();
  assert.equal(code, 143, stderr);
  assert.match(stderr, /alice closed, bob unconfirmed/);
  assert.match(stderr, /bob: close after its call finished failed \(AUTHORITY_UNAVAILABLE\); the platform closes an idle browser within 5 minutes/);
});

// Managed test users (founder 2026-10-20 22:45; backend tsk_b05cf814): a
// "test_user" actor gets a fresh platform test identity, signs in once in its
// own browser, and the identities are deleted after the browsers close.
function testUserClient({ identities, failCreate, failDelete } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, path, body) {
      calls.push({ method, path, body: structuredClone(body) });
      if (path === '/auth/test-users' && method === 'POST') {
        if (failCreate) throw new CliApiError('NOT_FOUND', 'route missing', 404);
        return { identities: identities ?? Array.from({ length: body.count }, (_, i) => ({ user: { id: `tu_${i}`, email: `t-verify-${i}@club.test.somewhere.site`, role: 'user', email_verified: true, test: true } })) };
      }
      if (path === '/auth/test-users' && method === 'DELETE') {
        if (failDelete) throw new CliApiError('AUTH_STORE_UNAVAILABLE', 'store busy', 503);
        return { deleted: body.ids.length, ids: body.ids };
      }
      assert.equal(path, '/browser/test');
      if (body.close === true) return { session_id: body.session_id, closed: true };
      return report();
    },
  };
}
const teamFlow = {
  actors: { alice: { test_user: true }, bob: { test_user: true }, visitor: {} },
  journey: [
    { as: 'alice', path: '/', actions: [{ click: '#new' }] },
    { as: 'bob', path: '/', actions: [{ click: '#join' }] },
    { as: 'alice', actions: [{ click: '#check' }] },
    { as: 'visitor', path: '/', actions: [{ click: '#peek' }] },
  ],
};

test('test_user actors: one create call, one sign-in per actor, cleanup after browsers close', async () => {
  const client = testUserClient();
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(teamFlow), client, { runId: 'tu' }).run();
  assert.equal(result.passed, true, result.verdict);
  const creates = client.calls.filter((c) => c.path === '/auth/test-users' && c.method === 'POST');
  assert.equal(creates.length, 1, 'all test actors are created together');
  assert.deepEqual(creates[0].body, { project_id: 'club', count: 2, label: 'verify' });
  const runs = client.calls.filter((c) => c.path === '/browser/test' && c.body.close !== true).map((c) => c.body);
  assert.deepEqual(runs[0].auth, { user_id: 'tu_0' }, 'alice signs in as her own test identity');
  assert.deepEqual(runs[1].auth, { user_id: 'tu_1' }, 'bob signs in as a different test identity');
  assert.equal('auth' in runs[2], false, 'a continued actor reuses its signed-in browser; no second sign-in');
  assert.equal(runs[2].require_existing_session, true);
  assert.equal('auth' in runs[3], false, 'a plain actor stays signed out');
  const lastClose = client.calls.findLastIndex((c) => c.body?.close === true);
  const del = client.calls.findIndex((c) => c.path === '/auth/test-users' && c.method === 'DELETE');
  assert.ok(del > lastClose, 'identities are deleted only after every browser is closed');
  assert.deepEqual(client.calls[del].body, { project_id: 'club', ids: ['tu_0', 'tu_1'] });
  assert.deepEqual(result.test_users.identities.map((i) => [i.actor, i.user_id]), [['alice', 'tu_0'], ['bob', 'tu_1']]);
  assert.deepEqual(result.test_users.cleanup, { status: 'deleted', deleted: 2 });
  assert.ok(!JSON.stringify(result).match(/token|password/i), 'no credential field reaches the report');
});

test('test_user: creation failure starts no browser; mismatched or non-test identities are refused', async () => {
  for (const client of [testUserClient({ failCreate: true }),
    testUserClient({ identities: [{ user: { id: 'u1', email: 'a@x.test', test: true } }] }),
    testUserClient({ identities: [{ user: { id: 'u1', email: 'real@x.com' } }, { user: { id: 'u2', email: 'b@x.test', test: true } }] })]) {
    await assert.rejects(createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(teamFlow), client).run(), /No browser was started|no browser was started/);
    assert.equal(client.calls.filter((c) => c.path === '/browser/test').length, 0);
  }
});

test('test_user: kept on request, unconfirmed delete is reported, invalid combinations refused', async () => {
  const kept = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(teamFlow), testUserClient(), { keepTestUsers: true }).run();
  assert.equal(kept.test_users.cleanup.status, 'kept');
  const failed = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(teamFlow), testUserClient({ failDelete: true })).run();
  assert.equal(failed.test_users.cleanup.status, 'unconfirmed');
  assert.match(failed.test_users.cleanup.reason, /AUTH_STORE_UNAVAILABLE/);
  assert.throws(() => normalizeVerifyJourney({ actors: { a: { test_user: true, auth: { user_id: 'x' } } }, journey: [{ as: 'a' }] }), /remove auth/);
  assert.throws(() => normalizeVerifyJourney({ actors: { a: { test_user: 'yes' } }, journey: [{ as: 'a' }] }), /must be true/);
});

// Parallel groups (realtime checks): { "parallel": [segment, segment] } runs
// segments by different actors at the same time, each in its own browser.
const realtime = {
  actors: {
    alice: { cookies: [{ name: 'pref', value: SECRET_COOKIE }] },
    bob: { auth: { user_id: 'usr_bob' }, local_storage: { theme: SECRET_STORAGE } },
  },
  journey: [
    { as: 'alice', path: '/chat', actions: [{ click: '#join' }] },
    { parallel: [
      { as: 'alice', path: '/chat', actions: [{ wait: { selector: '#feed', text: 'hello' } }] },
      { as: 'bob', path: '/chat', actions: [{ fill: '#msg', value: 'hello' }, { click: '#send' }] },
    ] },
    { as: 'bob', actions: [{ expect: { selector: '#feed', text: 'hello' } }] },
  ],
};

/** Holds each segment answer until `expected` segment calls have arrived. */
function barrierClient(expected, answer = () => report()) {
  const events = [];
  const waiting = [];
  const client = {
    events,
    runs: () => events.filter((e) => e.type === 'received').map((e) => e.body),
    closes: (actor) => events.filter((e) => e.type === 'close' && (!actor || e.session.endsWith(`-${actor}`))),
    async call(_method, _path, body) {
      if (body.close === true) {
        events.push({ type: 'close', session: body.session_id, at: Date.now() });
        return { session_id: body.session_id, closed: true };
      }
      const n = client.runs().length + 1;
      events.push({ type: 'received', body: structuredClone(body), n });
      if (!expected.includes(n)) return answer(body, n);
      const gate = deferred();
      waiting.push(gate);
      if (expected.every((m) => m <= n)) for (const item of waiting.splice(0)) item.resolve();
      // Sequential dispatch would never release the gate: fail instead of hanging.
      const timer = setTimeout(() => gate.reject(new Error(`call ${n} waited 2s for the rest of its parallel group to arrive`)), 2000);
      await gate.promise.finally(() => clearTimeout(timer));
      events.push({ type: 'resolved', session: body.session_id, n });
      return answer(body, n);
    },
  };
  return client;
}

test('parallel: a group\'s calls are in flight together, each built as its own actor\'s ordinary call', async () => {
  const journey = normalizeVerifyJourney(realtime);
  assert.deepEqual(journey.journey.map((s) => s.group), [undefined, 1, 1, undefined], 'a group flattens into consecutive tagged segments');
  const client = barrierClient([2, 3]);
  const result = await createVerifyJourneyRun({ project_id: 'club' }, journey, client, { runId: 'p1' }).run();
  assert.equal(result.passed, true, result.verdict);
  assert.match(result.verdict, /^PASS — 4 segments by 2 users \(alice, bob\) passed, 2 of them in parallel groups/);

  const order = client.events.filter((e) => e.type !== 'close').map((e) => `${e.type}:${e.n}`);
  assert.ok(order.indexOf('received:3') < order.indexOf('resolved:2') && order.indexOf('received:3') < order.indexOf('resolved:3'),
    `both group bodies arrived before either answer resolved (${order.join(' ')})`);
  assert.ok(order.indexOf('received:4') > order.indexOf('resolved:2') && order.indexOf('received:4') > order.indexOf('resolved:3'),
    'the next item starts only after the whole group settled');

  const [alice1, alice2, bob1, bob2] = client.runs();
  assert.deepEqual([alice1, alice2, bob1, bob2].map((b) => b.session_id), ['vf-p1-alice', 'vf-p1-alice', 'vf-p1-bob', 'vf-p1-bob']);
  // alice continues inside the group: same browser, a goto, never re-seeded.
  assert.equal(alice2.require_existing_session, true);
  assert.equal('url' in alice2, false);
  assert.deepEqual(alice2.actions[0], { goto: '/chat' });
  for (const field of ['auth', 'local_storage', 'cookies', 'headers']) assert.equal(field in alice2, false, `continued alice is not re-seeded (${field})`);
  // bob starts inside the group: his first call, his own seeds only.
  assert.equal('require_existing_session' in bob1, false);
  assert.equal(bob1.url, '/chat');
  assert.deepEqual(bob1.auth, { user_id: 'usr_bob' });
  assert.deepEqual(bob1.local_storage, { theme: SECRET_STORAGE });
  assert.equal('cookies' in bob1, false, 'bob never receives alice\'s cookie');
  assert.equal(alice2.budget_ms, bob1.budget_ms, 'every segment of a group gets the same cap');
  assert.equal(bob2.require_existing_session, true);
  assert.equal('auth' in bob2, false, 'bob continues after the group without a second sign-in');

  assert.deepEqual(result.segments.map((s) => [s.segment, s.as, s.parallel_group]), [[1, 'alice', undefined], [2, 'alice', 1], [3, 'bob', 1], [4, 'bob', undefined]]);
  assert.match(formatVerifyJourneyReport(result).join('\n'), /segment 3 .*bob \[desktop\] \/chat .*parallel 1/);
  assert.deepEqual(result.cleanup, [{ actor: 'alice', status: 'closed' }, { actor: 'bob', status: 'closed' }]);
});

test('parallel: two first segments each carry only their own actor\'s seeds and test identity', async () => {
  const flow = {
    actors: { alice: { test_user: true }, bob: { cookies: [{ name: 'pref', value: SECRET_COOKIE }] } },
    journey: [{ parallel: [{ as: 'alice', path: '/a', actions: [{ click: '#x' }] }, { as: 'bob', actions: [{ click: '#y' }] }] }],
  };
  const inner = barrierClient([1, 2]);
  const client = { async call(method, path, body, query, opts) {
    if (path === '/auth/test-users') return method === 'POST' ? { identities: [{ user: { id: 'tu_a', email: 't@club.test', test: true } }] } : { deleted: 1 };
    return inner.call(method, path, body, query, opts);
  } };
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(flow), client, { runId: 'p2' }).run();
  assert.equal(result.passed, true, result.verdict);
  const [alice, bob] = inner.runs();
  assert.deepEqual(alice.auth, { user_id: 'tu_a' });
  assert.equal(alice.url, '/a');
  assert.equal('cookies' in alice, false);
  assert.deepEqual(bob.cookies, [{ name: 'pref', value: SECRET_COOKIE }]);
  assert.equal(bob.url, '/', 'a seeded first segment without a path starts at /');
  assert.equal('auth' in bob, false, 'bob never receives alice\'s test identity');
  assert.ok(!('require_existing_session' in alice) && !('require_existing_session' in bob));
});

test('parallel: groups are refused unless they are 2-3 segments by different actors, flat, with only "parallel"', () => {
  const actors = { a: {}, b: {}, c: {} };
  const seg = (as) => ({ as, actions: [{ click: '#x' }] });
  const flow = (item) => ({ actors, journey: [seg('a'), seg('b'), seg('c'), item] });
  assert.throws(() => normalizeVerifyJourney(flow({ parallel: [seg('a'), seg('a')] })), /journey\[3\]\.parallel names a twice; each segment in a parallel group is a different actor/);
  assert.throws(() => normalizeVerifyJourney(flow({ parallel: [seg('a')] })), /journey\[3\]\.parallel has 1 segment; a parallel group runs 2 to 3 segments at the same time/);
  assert.throws(() => normalizeVerifyJourney(flow({ parallel: [seg('a'), seg('b'), seg('c'), seg('a')] })), /journey\[3\]\.parallel has 4 segments; a parallel group runs 2 to 3/);
  assert.throws(() => normalizeVerifyJourney(flow({ parallel: 'a,b' })), /journey\[3\]\.parallel must be an array of segments/);
  assert.throws(() => normalizeVerifyJourney(flow({ parallel: [seg('a'), { parallel: [seg('b'), seg('c')] }] })), /journey\[3\]\.parallel\[1\] is a parallel group inside a parallel group; groups cannot be nested/);
  assert.throws(() => normalizeVerifyJourney(flow({ parallel: [seg('a'), seg('b')], as: 'c', viewport: 'mobile' })), /journey\[3\] is a parallel group, so its only field is "parallel" \(found as, viewport\)/);
  // Every per-segment rule still applies, named by its place in the group.
  assert.throws(() => normalizeVerifyJourney(flow({ parallel: [seg('a'), { as: 'b', path: '//evil.test' }] })), /journey\[3\]\.parallel\[1\]\.path must be a path on this app/);
  assert.throws(() => normalizeVerifyJourney(flow({ parallel: [seg('a'), { as: 'z' }] })), /journey\[3\]\.parallel\[1\]\.as must name one of the actors/);
  assert.throws(() => normalizeVerifyJourney(flow({ parallel: [seg('a'), { as: 'b', extra: 1 }] })), /journey\[3\]\.parallel\[1\] has unsupported field: extra/);
  assert.throws(() => normalizeVerifyJourney(flow({ parallel: [seg('a'), { as: 'b', visible_only: 'yes' }] })), /journey\[3\]\.parallel\[1\]\.visible_only must be boolean/);
  assert.doesNotThrow(() => normalizeVerifyJourney(flow({ parallel: [seg('a'), { as: 'b', viewport: 'mobile', expect_requests: [{ path: '/api/x', status: 403 }] }] })));
});

test('parallel: segments in groups count toward the segment and action limits', () => {
  const thirty = Array.from({ length: 30 }, () => ({ click: '#x' }));
  const actors = { a: {}, b: {}, c: {} };
  const trio = { parallel: [{ as: 'a' }, { as: 'b' }, { as: 'c' }] };
  assert.doesNotThrow(() => normalizeVerifyJourney({ actors, journey: [trio, trio, trio, trio] }), '4 groups of 3 are exactly 12 segments');
  assert.throws(() => normalizeVerifyJourney({ actors, journey: [trio, trio, trio, trio, { as: 'a' }] }),
    /journey has 13 segments \(counting each segment inside a parallel group\); the limit is 12/);
  assert.throws(() => normalizeVerifyJourney({ actors, journey: [{ as: 'a' }, { parallel: [{ as: 'a', path: '/x', actions: thirty }, { as: 'b' }] }] }),
    /journey\[1\]\.parallel\[0\] has 31 actions \(including the goto for its path\); the limit per segment is 30/);
  const wide = { parallel: [{ as: 'a', actions: thirty }, { as: 'b', actions: thirty }, { as: 'c', actions: thirty }] };
  assert.throws(() => normalizeVerifyJourney({ actors, journey: [wide, { as: 'a', actions: thirty }, { as: 'b', actions: [{ click: '#y' }] }] }),
    /journey has 121 actions in total; the limit is 120/);
  assert.equal(VERIFY_JOURNEY_LIMITS.parallel_segments, 3);
});

test('parallel: a failure in one group segment stops later items, and both group results are reported', async () => {
  const client = barrierClient([2, 3], (_body, n) => (n === 3
    ? report({ passed: false, steps: [{ step: 0, action: 'fill', ok: false, error: 'selector #msg did not match' }] })
    : report()));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(realtime), client, { runId: 'p3' }).run();
  assert.equal(result.passed, false);
  assert.match(result.verdict, /^FAIL — segment 3 — step 1 \(fill #msg\) failed at bob #3 desktop: selector #msg did not match/);
  assert.equal(client.runs().length, 3, 'the item after the group did not run');
  assert.deepEqual(result.segments.map((s) => [s.segment, s.ran, s.passed]), [[1, true, true], [2, true, true], [3, true, false], [4, false, false]]);
  assert.equal(result.browser_runs, 3);
  assert.deepEqual(client.closes().map((e) => e.session).sort(), ['vf-p3-alice', 'vf-p3-bob']);

  // A refusal for the first group segment and a failed report for the second:
  // the first stop in segment order is the verdict; both are reported.
  const refused = barrierClient([2, 3], (_body, n) => {
    if (n === 2) throw new CliApiError('SESSION_EXPIRED', 'no live browser', 409);
    if (n === 3) return report({ passed: false, steps: [{ step: 0, action: 'fill', ok: false, error: 'nope' }] });
    return report();
  });
  const second = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(realtime), refused, { runId: 'p4' }).run();
  assert.match(second.verdict, /^FAIL — segment 2 \(alice, desktop\): alice's browser ended between segments, so segment 2 did not run/);
  assert.equal(second.segments[1].error.code, 'SESSION_EXPIRED');
  assert.deepEqual([second.segments[2].ran, second.segments[2].passed], [true, false], 'bob\'s group result is still reported');
  assert.equal(second.segments[3].ran, false);
});

test('parallel: an execution cap in a group names the segments after the group as not run', async () => {
  // alice's group segment is [goto /chat, wait]: the cap hits after the goto.
  const capped = report({ passed: false, incomplete: { reason: 'execution_cap', completed: 1, next_step: 1, budget_ms: 180000, elapsed_ms: 180000 }, steps: [{ step: 0, action: 'goto', ok: true }] });
  const client = barrierClient([2, 3], (_body, n) => (n === 2 ? capped : report()));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(realtime), client, { runId: 'p5' }).run();
  assert.equal(client.runs().length, 3);
  assert.match(result.verdict, /^INCOMPLETE — segment 2 \(alice, desktop\) reached its 180s execution cap/);
  assert.match(result.verdict, / Segment 4 did not run\./, 'bob\'s parallel segment ran, so only the item after the group is named');
  assert.equal(result.segments[1].incomplete.reason, 'execution_cap');
  assert.equal(result.segments[2].passed, true, 'bob\'s parallel segment is reported on its own');
});

test('parallel: closeAll during a group closes both actors and waits for both in-flight calls', async () => {
  const aliceCall = deferred();
  const bobCall = deferred();
  const client = controllableClient({
    closeDelayMs: 10,
    segment: (body, n) => (n === 2 ? aliceCall.promise : n === 3 ? bobCall.promise : report()),
  });
  const journeyRun = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(realtime), client, { runId: 'p6' });
  const running = journeyRun.run();
  await until(() => client.runs().length === 3);
  journeyRun.stop('VERIFY_INTERRUPTED', 'Stopped by SIGINT.');
  const cleaning = journeyRun.closeAll();
  await until(() => client.closes().length === 2);
  let done = false;
  void cleaning.then(() => { done = true; });
  aliceCall.resolve(report());
  const aliceSettledAt = Date.now();
  await until(() => client.closes('alice').length === 2);
  assert.equal(done, false, 'cleanup still waits for bob\'s call');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false);
  bobCall.resolve(report());
  const bobSettledAt = Date.now();
  const { cleanup } = await cleaning;
  const result = await running;
  assert.ok(client.closes('alice')[1].at >= aliceSettledAt && client.closes('bob')[1].at >= bobSettledAt,
    'each actor is closed again after its own call settled');
  assert.equal(client.closes('bob').length, 2);
  assert.deepEqual(cleanup, [{ actor: 'alice', status: 'closed' }, { actor: 'bob', status: 'closed' }]);
  assert.equal(client.runs().length, 3, 'nothing starts after the group once cleanup began');
  assert.deepEqual(result.segments.map((s) => s.ran), [true, true, true, false]);
  assert.match(result.verdict, /^FAIL — segment 4 \(bob, desktop\): Stopped by SIGINT\. \[VERIFY_INTERRUPTED\]$/);
});

test('parallel: an unanswered call in a group is unconfirmed for that actor only; a hung one stays inside the budget', async () => {
  const client = controllableClient({
    segment: (_body, n) => {
      if (n === 3) throw new CliApiError('TIMEOUT', 'No response from POST /browser/test after 225s.', 0);
      return report();
    },
  });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(realtime), client, { runId: 'p7', recloseAfterAbandonedMs: 10 }).run();
  assert.match(result.verdict, /^INCOMPLETE — Outcome unknown/);
  assert.equal(result.segments[1].passed, true);
  assert.equal(result.segments[2].outcome_unknown, true);
  assert.equal(result.segments[3].ran, false);
  assert.deepEqual(result.cleanup.map((item) => [item.actor, item.status]), [['alice', 'closed'], ['bob', 'unconfirmed']]);
  assert.match(result.cleanup[1].reason, /got no answer, so the platform may still start it/);
  assert.equal(client.closes('bob').length, 2, 'the abandoned actor is closed again');

  const hung = controllableClient({ segment: (_body, n) => (n === 2 || n === 3 ? new Promise(() => {}) : report()) });
  const journeyRun = createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(realtime), hung, { runId: 'p8', cleanupBudgetMs: 300 });
  void journeyRun.run();
  await until(() => hung.runs().length === 3);
  const startedAt = Date.now();
  const { cleanup } = await journeyRun.closeAll();
  assert.ok(Date.now() - startedAt < 600, 'both waits share one cleanup budget');
  assert.deepEqual(cleanup.map((item) => item.status), ['unconfirmed', 'unconfirmed']);
  assert.ok(cleanup.every((item) => /still running when cleanup ran out of time/.test(item.reason)));
});

test('parallel: the deadline is checked once before a group, which then starts together or not at all', async () => {
  let clock = 0;
  const client = controllableClient({
    segment: (_body, n) => { if (n === 1) clock = VERIFY_JOURNEY_LIMITS.deadline_ms - 50_000; return report(); },
  });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, normalizeVerifyJourney(realtime), client, { runId: 'p9', now: () => clock }).run();
  assert.equal(client.runs().length, 1, 'no group segment started');
  assert.match(result.verdict, /^FAIL — segment 2 \(alice, desktop\): The journey reached its 10-minute limit\. Segments 2–3 \(in parallel\) were not started: 50s were left/);
  assert.deepEqual(result.segments.map((s) => [s.ran, s.parallel_group]), [[true, undefined], [false, 1], [false, 1], [false, undefined]]);
});

test('each segment reports the platform timing (numbers only) plus its request wall; the journey reports its phases', async () => {
  let clock = 1_000;
  const calls = [];
  const client = {
    async call(method, path, body) {
      calls.push({ method, path, body });
      if (path === '/auth/test-users' && method === 'POST') { clock += 30; return { identities: [{ user: { id: 'u1', email: 'a@t.test', test: true } }, { user: { id: 'u2', email: 'b@t.test', test: true } }] }; }
      if (path === '/auth/test-users' && method === 'DELETE') { clock += 40; return { deleted: 2 }; }
      if (body.close === true) { clock += 70; return { session_id: body.session_id, closed: true }; }
      clock += 50;
      return report({ timing: { browser_acquire_ms: 120, actions_ms: 300, evidence_ms: 20, browser_reused: false,
        final_url: 'https://club.somewhere.site/secret?token=x', note_ms: 'not a number', 'https://x/?token=abc_ms': 5, nested_ms: { a: 1 } } });
    },
  };
  const journey = normalizeVerifyJourney({
    actors: { alice: { test_user: true }, bob: { test_user: true } },
    journey: [
      { parallel: [{ as: 'alice', path: '/a', actions: [{ click: '#a' }] }, { as: 'bob', path: '/b', actions: [{ click: '#b' }] }] },
      { as: 'alice', path: '/c', actions: [{ click: '#c' }] },
    ],
  });
  const result = await createVerifyJourneyRun({ project_id: 'club' }, journey, client, { runId: 'tm', now: () => clock }).run();
  assert.equal(result.passed, true);
  assert.equal(result.segments.length, 3);
  for (const segment of result.segments) {
    assert.deepEqual(Object.keys(segment.timing).sort(), ['actions_ms', 'browser_acquire_ms', 'browser_reused', 'evidence_ms', 'request_wall_ms']);
    assert.equal(segment.timing.browser_acquire_ms, 120);
    assert.ok(segment.timing.request_wall_ms >= 50, 'each call is timed from its own dispatch to its own answer');
  }
  assert.ok(!JSON.stringify(result.segments.map((s) => s.timing)).includes('token'), 'no URL or string key/value reaches timing');
  assert.equal(result.timing.test_users_create_ms, 30);
  assert.equal(result.timing.segments_ms, 150, 'three 50 ms calls; browser cleanup is not counted in segments');
  assert.equal(result.timing.cleanup_ms, 140, 'two 70 ms closes');
  assert.equal(result.timing.test_users_delete_ms, 40);
});

function keepClient(answer = () => report({ timing: { browser_reused: false }, idle_expires_at: '2026-10-22T00:10:00Z', absolute_expires_at: '2026-10-22T01:00:00Z', session_expires_at: '2026-10-22T00:10:00Z' })) {
  const calls = [];
  return {
    calls,
    runs: () => calls.filter((call) => call.path === '/browser/test' && call.body.close !== true),
    closes: () => calls.filter((call) => call.path === '/browser/test' && call.body.close === true),
    async call(method, path, body) {
      calls.push({ method, path, body: structuredClone(body) });
      if (path === '/auth/test-users' && method === 'POST') return { identities: [{ user: { id: 'u-a', email: 'a@t.test', test: true } }, { user: { id: 'u-b', email: 'b@t.test', test: true } }] };
      if (path === '/auth/test-users' && method === 'DELETE') return { deleted: body.ids.length };
      if (body.close === true) return { session_id: body.session_id, closed: true };
      return answer(body, calls.filter((call) => call.path === '/browser/test' && call.body.close !== true).length);
    },
  };
}
const keepFlow = () => normalizeVerifyJourney({
  actors: { alice: { test_user: true }, bob: { test_user: true } },
  journey: [
    { as: 'alice', path: '/private', actions: [{ click: '#save' }] },
    { as: 'bob', path: '/private', actions: [{ click: '#lookup' }], expect_requests: [{ path: '/api/notes/key/k', status: 404 }] },
  ],
});

test('--keep-actors: a fully passed run keeps each browser and test user under a stable name, and every run starts from its path', async () => {
  const client = keepClient();
  const result = await createVerifyJourneyRun({ project_id: 'club' }, keepFlow(), client, { runId: 'k1', keep: { key: 'abc123' } }).run();
  assert.equal(result.passed, true);
  const [alice, bob] = client.runs().map((call) => call.body);
  assert.equal(alice.session_id, 'vf-kabc123-alice', 'stable across runs, not per run id');
  assert.equal(bob.session_id, 'vf-kabc123-bob');
  assert.equal(alice.require_existing_session, undefined, 'a first call may reconnect or start fresh (never refuses)');
  assert.deepEqual(alice.actions[0], { goto: '/private' }, 'a kept browser is navigated to the segment path before its steps');
  assert.equal(alice.auth.user_id, 'u-a', 'the identity still signs in on the first call');
  assert.equal(client.closes().length, 0, 'kept browsers are not closed');
  assert.equal(client.calls.filter((call) => call.method === 'DELETE').length, 0, 'kept test users are not deleted');
  assert.deepEqual(result.keep_actors, { kept: ['alice', 'bob'], reconnected: [], reused_identities: false });
  assert.equal(result.test_users.cleanup.status, 'kept');
  assert.deepEqual(result.cleanup.map((item) => item.status), ['kept_open', 'kept_open']);
  assert.equal(result.cleanup_confirmed, true);
});

test('--keep-actors: the next run reuses the kept identities and reports reconnected browsers', async () => {
  const client = keepClient(() => report({ timing: { browser_reused: true }, idle_expires_at: 'x', absolute_expires_at: 'y' }));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, keepFlow(), client, { runId: 'k2', keep: { key: 'abc123', identities: { alice: { user_id: 'u-a', email: 'a@t.test' }, bob: { user_id: 'u-b', email: 'b@t.test' } } } }).run();
  assert.equal(result.passed, true);
  assert.equal(client.calls.filter((call) => call.path === '/auth/test-users').length, 0, 'no identity is created or deleted');
  assert.deepEqual(result.keep_actors, { kept: ['alice', 'bob'], reconnected: ['alice', 'bob'], reused_identities: true });
});

test('--keep-actors: a failing run keeps nothing: every browser is closed and the test users deleted, as without the flag', async () => {
  const client = keepClient((_body, n) => n === 2 ? report({ passed: false, steps: [{ step: 0, action: 'click', ok: false, error: 'not found' }] }) : report({ idle_expires_at: 'x', absolute_expires_at: 'y' }));
  const result = await createVerifyJourneyRun({ project_id: 'club' }, keepFlow(), client, { runId: 'k3', keep: { key: 'abc123', identities: { alice: { user_id: 'u-a', email: 'a@t.test' }, bob: { user_id: 'u-b', email: 'b@t.test' } } } }).run();
  assert.equal(result.passed, false);
  assert.deepEqual(client.closes().map((call) => call.body.session_id).sort(), ['vf-kabc123-alice', 'vf-kabc123-bob']);
  assert.deepEqual(client.calls.filter((call) => call.method === 'DELETE').map((call) => call.body.ids), [['u-a', 'u-b']]);
  assert.deepEqual(result.keep_actors.kept, []);
});
