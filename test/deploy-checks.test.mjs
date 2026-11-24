import test from 'node:test';
import assert from 'node:assert/strict';
import { retryAfterMs } from '../dist/lib/poll-delay.js';
import { awaitDeployChecks, checksExitCode, checksJsonReport, formatChecksReport, parseChecksRead, runChecksNow, DEPLOY_CHECKS_RUNNING } from '../dist/lib/deploy-checks.js';

const checks = { status: 'running', read: 'GET /v1/deploy/log?project_id=p1&version=3' };

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('the read named by the platform becomes the API path and query', () => {
  assert.deepEqual(parseChecksRead(checks.read), { path: '/deploy/log', query: { project_id: 'p1', version: '3' } });
  assert.equal(parseChecksRead('POST /v1/x'), null);
});

test('starts with short waits until the access check settles and prints its sentence', async () => {
  const c = clock();
  const calls = [];
  const answers = [{ access_check: { status: 'pending', sentence: null } }, new Error('network'), { access_check: { status: 'checked', sentence: 'Only owners can read notes.', findings: [], checked_at: 'x' } }];
  const client = { call: async (method, path, body, query) => { calls.push({ method, path, query, at: c.now() }); const a = answers.shift(); if (a instanceof Error) throw a; return a; } };
  const check = await awaitDeployChecks(client, checks, c);
  assert.equal(check.status, 'checked');
  assert.deepEqual(calls.map(x => x.at), [0, 150, 450]);
  assert.deepEqual(calls[0], { method: 'GET', path: '/deploy/log', query: { project_id: 'p1', version: '3' }, at: 0 });
});

test('reading for somewhere test stops at 150 s; every read failing is the same as still running, never an error', async () => {
  const c = clock();
  let n = 0;
  const client = { call: async () => { n += 1; return { access_check: { status: 'pending', sentence: null } }; } };
  const check = await awaitDeployChecks(client, checks, c);
  assert.equal(check.status, 'pending');
  assert.ok(c.now() <= 150_000 && n === 152, `${n} reads by ${c.now()} ms`);
  const failing = { call: async () => { throw new Error('down'); } };
  assert.equal(await awaitDeployChecks(failing, checks, clock()), null);
});

// End to end: a deploy whose answer carries checks prints the sentence (or puts access_check in --json), exit 0.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const PROJECT = 'aaaaaaaa-1111-4222-8333-666666666666';

test('a deploy with checks returns at once: one line saying the check is running, the read pointer in --json, no wait', async () => {
  const HOME = mkdtempSync(join(process.env.TMPDIR, 'sw-checks-home-'));
  const dir = mkdtempSync(join(process.env.TMPDIR, 'sw-checks-app-'));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_checks', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
  writeFileSync(join(dir, 'index.html'), '<html><body>checks</body></html>\n');
  const reads = [];
  const send = (res, payload) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
  const settled = { status: 'unavailable', sentence: 'The access check could not run on this release.', findings: [], checked_at: '2026-11-20T00:00:00Z' };
  const s = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.includes('/notices')) return send(res, { ok: true, data: { notices: [] } });
      if (req.url.startsWith('/v1/deploy/status')) return send(res, { ok: true, data: { published: true, active_release_id: 'rel_old', prod_version: 2 } });
      if (req.url.startsWith('/v1/projects/')) return send(res, { ok: true, data: { id: PROJECT, name: 'p', subdomain: 'checks', status: 'deployed' } });
      if (req.method === 'POST' && req.url === '/v1/deploy') return send(res, { ok: true, data: {
        project_id: PROJECT, version: 3, url: 'https://checks.somewhere.site', release_id: 'rel_new', active_release_id: 'rel_new', status: 'success',
        checks: { status: 'running', read: `GET /v1/deploy/log?project_id=${PROJECT}&version=3` },
      } });
      if (req.url.startsWith('/v1/deploy/log')) {
        reads.push(req.url);
        return send(res, { ok: true, data: { access_check: reads.length % 2 === 1 ? { status: 'pending', sentence: null } : settled } });
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${s.address().port}/v1`;
  const run = (extra) => new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, 'deploy', '--project', PROJECT, ...extra], { cwd: dir, env: { ...process.env, HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => (stdout += c)); child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
  try {
    const started = Date.now();
    const human = await run([]);
    assert.equal(human.status, 0, human.stderr);
    assert.ok(human.stdout.includes(DEPLOY_CHECKS_RUNNING) || human.stderr.includes(DEPLOY_CHECKS_RUNNING), human.stdout + human.stderr);
    assert.match(DEPLOY_CHECKS_RUNNING, /^Checks: running in the background; .* test` shows the result\.$/);
    assert.deepEqual(reads, [], 'the deploy never waits on the check');
    assert.ok(Date.now() - started < 15_000, 'no wait after the deploy answers');
    const json = await run(['--json']);
    assert.equal(json.status, 0, json.stderr);
    const out = JSON.parse(json.stdout);
    assert.deepEqual(out.checks, { status: 'running', read: `GET /v1/deploy/log?project_id=${PROJECT}&version=3` });
    assert.equal(out.access_check, undefined);
    assert.deepEqual(reads, []);
  } finally { await new Promise((r) => s.close(r)); }
});

const record = {
  status: 'checked', sentence: 'One saved check failed: your saved check "add a note" failed at step 2 on a phone.', findings: [{ kind: 'saved' }],
  checks: [
    { name: 'Your check "add a note"', as: 'user_a', method: 'flow', path: 'checks/add-a-note.json', status: 200, expected: 'every step passes', pass: true },
    { name: 'Your check "add a note" on a phone', as: 'user_a', method: 'flow', path: 'checks/add-a-note.json', status: 200, expected: 'every step passes', pass: false },
  ],
  passed: false, saved_checks: 1, pages_checked: 3, test_users: 2,
};

test('somewhere test reads the stored result of the last deploy; waits only while it is running; --again or no result starts a run', async () => {
  // Settled result stored: one read, no new run.
  const stored = []; const c0 = clock();
  const settledClient = { call: async (method, path, body, query) => { stored.push({ method, path, query }); return { access_check: record }; } };
  const s1 = await runChecksNow(settledClient, 'p1', c0);
  assert.deepEqual(stored, [{ method: 'GET', path: '/deploy/log', query: { project_id: 'p1' } }]);
  assert.match(formatChecksReport(s1).join('\n'), /FAIL Your check "add a note" on a phone[\s\S]*Response 1: HTTP 200[\s\S]*Reproduce:.*checks\/add-a-note.json/);
  assert.equal(checksExitCode(s1), 1);
  assert.equal(checksExitCode({ ...record, passed: true, checks: record.checks.map(l => ({ ...l, pass: true })) }), 0);
  // Still running: it waits for that same run.
  const c1 = clock(); let reads = 0;
  const runningClient = { call: async (method) => { if (method === 'POST') throw new Error('no new run'); reads += 1; return { access_check: reads < 3 ? { status: 'pending', sentence: null } : record }; } };
  assert.equal((await runChecksNow(runningClient, 'p1', c1)).status, 'checked');
  // No stored result, or --again: a fresh run, then its record.
  const calls = []; const c2 = clock();
  const freshClient = { call: async (method, path, body, query) => {
    calls.push({ method, path, body, query });
    if (method === 'POST') return { status: 'running', version: 4, read: 'GET /v1/deploy/log?project_id=p1&version=4' };
    return { access_check: calls.length < 4 ? (query.version ? { status: 'pending', sentence: null } : null) : record };
  } };
  await runChecksNow(freshClient, 'p1', c2);
  assert.deepEqual(calls[1], { method: 'POST', path: '/deploy/checks', body: { project_id: 'p1' }, query: undefined });
  const again = []; 
  await runChecksNow({ call: async (method, path, body, query) => { again.push(method); return method === 'POST' ? { read: 'GET /v1/deploy/log?project_id=p1&version=5' } : { access_check: record }; } }, 'p1', { ...clock(), again: true });
  assert.deepEqual(again, ['POST', 'GET']);
  // Never finished: no verdict, so not a pass.
  const c3 = clock();
  const pending = await runChecksNow({ call: async (method) => method === 'POST' ? { read: 'GET /v1/deploy/log?project_id=p1&version=4' } : { access_check: { status: 'pending', sentence: null } } }, 'p1', c3);
  assert.ok(c3.now() <= 150_000 && c3.now() >= 147_000, `${c3.now()} ms`);
  assert.match(formatChecksReport(pending)[0], /did not finish within 150 s/);
  assert.equal(checksExitCode(pending), 2);
  assert.equal(checksExitCode({ status: 'checked', sentence: null, passed: false, findings: [] }), 2);
});

test('somewhere test with no file runs the platform checks with no local browser and exits by their verdict', async () => {
  const HOME = mkdtempSync(join(process.env.TMPDIR, 'sw-test-home-'));
  const dir = mkdtempSync(join(process.env.TMPDIR, 'sw-test-app-'));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_checks', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: PROJECT }) + '\n');
  // A stale script in tests/ is not run: no Playwright is installed, and none is needed.
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'tests', 'app-check.mjs'), "throw new Error('must not run');\n");
  const requests = [];
  let passed = false;
  let custom;
  const send = (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.includes('/notices')) return send(res, 200, { ok: true, data: { notices: [] } });
      requests.push(`${req.method} ${req.url.split('?')[0]}${body ? ' ' + body : ''}`);
      if (req.method === 'POST' && req.url === '/v1/deploy/checks') return send(res, 202, { ok: true, data: { status: 'running', version: 4, read: `GET /v1/deploy/log?project_id=${PROJECT}&version=4` } });
      if (req.url.startsWith('/v1/deploy/log')) return send(res, 200, { ok: true, data: { access_check: custom ?? { ...record, passed, ...(passed ? { checks: record.checks.map(l => ({ ...l, pass: true })), sentence: 'Every check passed.' } : {}) } } });
      send(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${s.address().port}/v1`;
  const run = (extra) => new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, 'test', ...extra], { cwd: dir, env: { ...process.env, HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => (stdout += c)); child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
  try {
    const failing = await run([]);
    assert.equal(failing.status, 1, failing.stderr);
    assert.match(failing.stdout, /^FAIL Your check "add a note" on a phone$/m);
    assert.deepEqual(JSON.parse(failing.stdout.trim().split('\n').at(-1)),
      { outcome: 'failed', counts: { passed: 1, failed: 1, could_not_check: 0, warnings: 0 }, not_checked: null });
    assert.doesNotMatch(failing.stdout + failing.stderr, /must not run|Playwright/);
    assert.deepEqual(requests.slice(0, 1), ['GET /v1/deploy/log'], 'it reads the last deploy\'s stored result first');
    const json = await run(['--json']);
    assert.equal(json.status, 1);
    assert.equal(JSON.parse(json.stdout).passed, false);
    passed = true;
    const passing = await run([]);
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /^PASS Browser flow .* — The stored result has no observation.$/m);
    assert.equal(JSON.parse(passing.stdout.trim().split('\n').at(-1)).outcome, 'passed');

    const coverage = { routes_without_read_check: ['/api/items/:id'], routes_without_write_check: ['/api/items/:id'],
      schedules_not_run: ['daily-digest'], other: ['Function input boundaries'] };
    custom = { status: 'checked', passed: true, routes_checked: 0, routes_discovered: 1, not_checked: coverage, checks: [{
      name: "POST /__sw/data (built-in data endpoint), update a test person's items row as a stranger",
      as: 'stranger', method: 'POST', path: '/__sw/data', status: 404, pass: true, outcome: 'passed',
      responses: [{ status: 404, observed: 'Access refused. The owner still sees the same row.' }],
    }] };
    const scoped = await run([]);
    assert.equal(scoped.status, 0);
    assert.match(scoped.stdout, /^PASS POST \/__sw\/data \(built-in data endpoint\).*HTTP 404.*Access refused\. The owner still sees the same row\.$/m);
    assert.match(scoped.stdout, /^0 of 1 app routes had a completed read check\.$/m);
    assert.match(scoped.stdout, /^1 route without a write check \(\/api\/items\/:id\)\.$/m);
    assert.match(scoped.stdout, /^1 registered schedule did not run \(daily-digest\)\.$/m);
    assert.deepEqual(JSON.parse(scoped.stdout.trim().split('\n').at(-1)), {
      outcome: 'passed', counts: { passed: 1, failed: 0, could_not_check: 0, warnings: 0 },
      not_checked: coverage, routes_checked: 0, routes_discovered: 1,
    });
    const scopedJson = await run(['--json']);
    assert.equal(scopedJson.status, 0);
    assert.deepEqual(JSON.parse(scopedJson.stdout).not_checked, coverage);

    custom = { status: 'checked', passed: false, checks: [], sentence: 'Warning: A server function crashed: GET /favicon.ico. A test row could not be removed after the check.',
      findings: [{ kind: 'crash', via: 'GET /favicon.ico' }, { kind: 'cleanup', table: 'bookings', left_behind: 'Test row bookings / test-42 may remain.' }] };
    const cleanup = await run([]);
    assert.equal(cleanup.status, 2);
    assert.doesNotMatch(cleanup.stdout, /crashed|^FAIL/m);
    assert.match(cleanup.stdout, /Could not check cleanup: Test row bookings \/ test-42 may remain/);
    assert.equal(JSON.parse(cleanup.stdout.trim().split('\n').at(-1)).outcome, 'could_not_check');

    custom = { ...custom, passed: true, checks: [{ name: 'Pages load on desktop', pass: true }],
      findings: [{ kind: 'crash', via: 'GET /api/boom', request_id: 'exception-id' }] };
    const warning = await run([]);
    assert.equal(warning.status, 0);
    assert.match(warning.stdout, /Warning: A server function crashed: GET \/api\/boom/);
    assert.equal(JSON.parse(warning.stdout.trim().split('\n').at(-1)).counts.warnings, 1);

    custom.findings = [{ kind: 'function_http_error', via: 'GET /api/unsure', status: 503, request_id: 'unmatched-id' },
      { kind: 'function_http_error', via: 'GET /api/no-id', status: 500 }];
    const unresolved = await run([]);
    assert.equal(unresolved.status, 0);
    assert.match(unresolved.stdout, /GET \/api\/unsure returned 5xx; no error record found yet \(HTTP 503, request ID unmatched-id\)/);
    assert.match(unresolved.stdout, /GET \/api\/no-id returned 5xx; no error record found yet \(HTTP 500\)/);
    assert.doesNotMatch(unresolved.stdout, /crashed/);
    assert.equal(JSON.parse(unresolved.stdout.trim().split('\n').at(-1)).counts.warnings, 2);

    custom.checks = [];
    const empty = await run([]);
    assert.equal(empty.status, 2);
    assert.match(empty.stdout, /Could not check: no named checks ran/);

    custom = { status: 'checked', passed: false, checks: [{ name: 'A stranger cannot list members', as: 'stranger', pass: false,
      outcome: 'could_not_check', detail: 'Inconsistent: tell us. Request ID: one, two.',
      request: { method: 'POST', url: 'https://app.example/__sw/data', body: { table: 'members', operation: 'list' } },
      responses: [{ status: 200, request_id: 'one', observed: 'A row was returned' }, { status: 200, request_id: 'two', observed: 'Empty list' }],
    }] };
    const inconsistent = await run([]);
    assert.equal(inconsistent.status, 2);
    assert.match(inconsistent.stdout, /Response 1: HTTP 200.*row was returned/);
    assert.match(inconsistent.stdout, /Response 2: HTTP 200.*Empty list/);
    assert.match(inconsistent.stdout, /Inconsistent: tell us.*one, two/);
    assert.doesNotMatch(inconsistent.stdout, /^FAIL/m);
    custom.checks[0].outcome = 'failed';
    custom.checks[0].responses[1].observed = 'A row was returned';
    delete custom.checks[0].detail;
    const confirmed = await run(['--json']);
    assert.equal(confirmed.status, 1);
    assert.equal(confirmed.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(confirmed.stdout).outcome, 'failed');
  } finally { await new Promise((r) => s.close(r)); }
});

test('a targeted check starts a separate run and both reports show its partial coverage', async () => {
  const only = 'checks/add-note.json';
  const calls = [];
  const partial = {
    ...record, scope: 'partial', selection: only, checked_parts: [only], passed: true,
    checks: [record.checks[0]],
    not_checked: { routes_without_read_check: [], routes_without_write_check: [], schedules_not_run: [],
      other: ['Access probes', 'Browser page crawl', 'Other saved checks'] },
  };
  const client = { call: async (method, path, body, query) => {
    calls.push({ method, path, body, query });
    return method === 'POST'
      ? { scope: 'partial', selection: only, read: 'GET /v1/deploy/log?project_id=p1&check_run_id=chk_one' }
      : { access_check: partial };
  } };
  const result = await runChecksNow(client, 'p1', { ...clock(), only });
  assert.equal(checksExitCode(result), 0);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/deploy/checks/targeted', body: { project_id: 'p1', check: only }, query: undefined },
    { method: 'GET', path: '/deploy/log', body: undefined, query: { project_id: 'p1', check_run_id: 'chk_one' } },
  ]);
  const human = formatChecksReport(result);
  assert.match(human[0], /Partial smoke check/);
  assert.equal(human[1], 'Checked checks/add-note.json.');
  assert.match(human.join('\n'), /Other checks skipped or out of scope: Access probes, Browser page crawl, Other saved checks/);
  for (const report of [JSON.parse(human.at(-1)), checksJsonReport(result)]) {
    assert.equal(report.scope, 'partial');
    assert.equal(report.outcome, 'passed');
    assert.deepEqual(report.checked_parts, [only]);
    assert.deepEqual(report.not_checked, partial.not_checked);
  }
});

test('a targeted check cannot pass on a full result or a different selection', async () => {
  const result = await runChecksNow({ call: async (method) => method === 'POST'
    ? { scope: 'partial', selection: 'access', read: 'GET /v1/deploy/log?project_id=p1&check_run_id=chk_one' }
    : { access_check: { ...record, passed: true, checks: [record.checks[0]] } } },
  'p1', { ...clock(), only: 'access' });
  assert.equal(checksExitCode(result), 2);
  assert.equal(result.scope, 'partial');
  assert.deepEqual(result.checked_parts, []);
  assert.match(formatChecksReport(result).join('\n'), /No parts ran/);
});

test('hosted reads honor Retry-After from admission and status polling', async () => {
  const c = clock();
  const reads = [];
  const client = { call: async (method, path, body, query, opts) => {
    if (method === 'POST') {
      opts.onRetryAfter(2000);
      return { read: checks.read };
    }
    reads.push(c.now());
    if (reads.length === 1) {
      opts.onRetryAfter(3000);
      return { access_check: { status: 'pending', sentence: null } };
    }
    return { access_check: record };
  } };
  await runChecksNow(client, 'p1', { ...c, again: true });
  assert.deepEqual(reads, [2000, 5000]);
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('Tue, 24 Nov 2026 10:30:03 GMT', Date.parse('2026-11-24T10:30:00Z')), 3000);
  assert.equal(retryAfterMs(null), undefined);
});
