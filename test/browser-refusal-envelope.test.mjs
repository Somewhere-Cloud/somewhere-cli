import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsk_de3c2c25: a browser refusal keeps the platform's code, HTTP status,
// request id, retry verdict and its documented data in `browser --json` and in
// `verify --json` refusals, while anything outside that data contract is
// dropped and text output is unchanged. Refusal shapes copy
// worker/src/routes/browser.ts; the CANARY fields stand for anything else a
// body might carry.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../bin/somewhere.js');
const CANARY = /CANARY/;

const REFUSALS = {
  admission: {
    status: 429,
    body: { ok: false, error: 'BROWSER_SESSION_LIMIT', message: 'You already have 10 of 10 browser runs active.', retry: true,
      data: { reason: 'concurrency_exhausted', used: 10, limit: 10, reserved_for_verify: 2, held_until: '2026-11-01T12:00:00.000Z',
        token: 'smt_CANARY_token', request_body: { password: 'CANARY-pw' } } },
    expect: { retry: true, data: { reason: 'concurrency_exhausted', used: 10, limit: 10, reserved_for_verify: 2, held_until: '2026-11-01T12:00:00.000Z' } },
  },
  live: {
    status: 429,
    body: { ok: false, error: 'BROWSER_SESSION_LIMIT', message: '10 of 10 live browser sessions are open.', retry: true, retry_after_ms: 30000,
      data: { reason: 'live_sessions_exhausted', limit: 10, live_session_ids: ['bob', 'amy', 42], other_live_sessions: 3, owner_email: 'CANARY@example.test' } },
    expect: { retry: true, retry_after_ms: 30000, data: { reason: 'live_sessions_exhausted', limit: 10, live_session_ids: ['bob', 'amy'], other_live_sessions: 3 } },
  },
  unknownOutcome: {
    status: 503,
    body: { ok: false, error: 'BROWSER_STARTUP_UNAVAILABLE', message: 'Browser startup or cleanup could not be confirmed. Work may still be pending, so an automatic repeat of the same request is not safe.',
      retry: false, data: { outcome_unknown: true, attempts: 2, held_until: '2026-11-01T12:06:45.000Z', debug: { stack: 'CANARY stack' } } },
    expect: { retry: false, data: { outcome_unknown: true, attempts: 2, held_until: '2026-11-01T12:06:45.000Z' } },
  },
  // Session names only ever come from the caller's own live-session limit:
  // an authorization or not-found refusal carries no data, whatever it holds.
  unauthorized: {
    status: 403,
    body: { ok: false, error: 'FORBIDDEN', message: 'You do not have access to this project.',
      data: { reason: 'live_sessions_exhausted', live_session_ids: ['CANARY-other-account-session'], other_live_sessions: 4 } },
    expect: {},
  },
  notFound: {
    status: 404,
    body: { ok: false, error: 'PROJECT_NOT_FOUND', message: 'Project not found.', retry: false,
      data: { live_session_ids: ['CANARY-other-account-session'], session_id: 'CANARY-other-session' } },
    expect: { retry: false },
  },
  // A limit code arriving under any other status is not that limit.
  wrongStatus: {
    status: 403,
    body: { ok: false, error: 'BROWSER_SESSION_LIMIT', message: 'Refused.',
      data: { reason: 'live_sessions_exhausted', limit: 10, live_session_ids: ['CANARY-session'], other_live_sessions: 1 } },
    expect: {},
  },
  // Documented names with the wrong shape are dropped: nested objects and
  // arrays, non-integers, free text in a timestamp, names outside the rule.
  nestedShapes: {
    status: 429,
    body: { ok: false, error: 'BROWSER_SESSION_LIMIT', message: '10 of 10 live browser sessions are open.', retry: true,
      data: { reason: 'live_sessions_exhausted', limit: { value: 'CANARY' }, other_live_sessions: 2.5,
        live_session_ids: ['ok-name', ['CANARY-nested'], { id: 'CANARY-obj' }, 'CANARY; rm -rf ~', 'x'.repeat(65), 'checkout.flow_2'] } },
    expect: { retry: true, data: { reason: 'live_sessions_exhausted', live_session_ids: ['ok-name', 'checkout.flow_2'] } },
  },
  unknownReason: {
    status: 429,
    body: { ok: false, error: 'BROWSER_SESSION_LIMIT', message: 'Refused.', retry: true,
      data: { reason: 'CANARY_reason', used: 1, limit: 2, held_until: 'tomorrow CANARY' } },
    expect: { retry: true },
  },
  badTimestamp: {
    status: 503,
    body: { ok: false, error: 'BROWSER_STARTUP_UNAVAILABLE', message: 'Browser startup or cleanup could not be confirmed.', retry: false,
      data: { outcome_unknown: 'yes', attempts: -1, held_until: '2026-11-01 CANARY' } },
    expect: { retry: false },
  },
  noVerdict: {
    status: 503,
    body: { ok: false, error: 'BROWSER_STARTUP_UNAVAILABLE', message: 'Browser test could not start.', data: { attempts: 1 } },
    expect: { data: { attempts: 1 } },
  },
};

let reply;
let requests = [];
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  if (req.url === '/') { res.writeHead(404); res.end(); return; }
  requests.push(`${req.method} ${req.url}`);
  res.writeHead(reply.status, { 'content-type': 'application/json', 'x-request-id': 'req_browser_fixture_01' });
  res.end(JSON.stringify(reply.body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

function run(args, t) {
  requests = [];
  const base = mkdtempSync(join(tmpdir(), 'sw-browser-refusal-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const configDir = join(base, 'config');
  const app = join(base, 'app');
  mkdirSync(configDir);
  mkdirSync(app);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ token: 'smt_fixture_access', user: { email: 'dev@example.test', username: 'dev' } }));
  writeFileSync(join(app, 'flow.json'), JSON.stringify({ actions: [{ click: '#save' }], viewports: ['desktop'] }));
  const local = `http://127.0.0.1:${server.address().port}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: app,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, HOME: base, USERPROFILE: base, SOMEWHERE_CONFIG_DIR: configDir,
        SOMEWHERE_API_URL: `${local}/v1`, SOMEWHERE_MCP_URL: `${local}/mcp`, SOMEWHERE_RUNNER_URL: local,
        SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
      },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v);
    child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, stderr, requests: [...requests] }));
  });
}

for (const [name, refusal] of Object.entries(REFUSALS)) {
  test(`browser --json keeps a ${name} refusal's code, status, request id, retry verdict and allowlisted data`, async (t) => {
    reply = refusal;
    const json = await run(['browser', 'https://example.com/', '--json'], t);
    assert.equal(json.status, 1, json.stdout + json.stderr);
    assert.deepEqual(json.requests, ['POST /v1/browser/test'], 'one request: no automatic retry');
    const body = JSON.parse(json.stdout);
    const { retry, retry_after_ms, data } = refusal.expect;
    assert.deepEqual(body, {
      ok: false, error: refusal.body.error, message: refusal.body.message, status: refusal.status,
      request_id: 'req_browser_fixture_01',
      ...(retry !== undefined ? { retry } : {}),
      ...(retry_after_ms !== undefined ? { retry_after_ms } : {}),
      ...(data ? { data } : {}),
    });
    assert.doesNotMatch(json.stdout + json.stderr, CANARY);

    // Text output is the one line it always was.
    const text = await run(['browser', 'https://example.com/'], t);
    assert.equal(text.status, 1);
    assert.equal(text.requests.length, 1);
    assert.ok(text.stderr.includes(`✗ ${refusal.body.message} [${refusal.body.error}, HTTP ${refusal.status}]`), text.stderr);
    assert.doesNotMatch(text.stderr, /request req_browser_fixture_01|CANARY/);
  });

  test(`verify --json refusals carry the same ${name} verdict`, async (t) => {
    reply = refusal;
    const json = await run(['verify', '--project', 'fixture', '--flow', 'flow.json', '--json'], t);
    assert.notEqual(json.status, 0, json.stdout + json.stderr);
    assert.deepEqual(json.requests, ['POST /v1/browser/test'], 'one request: no automatic retry');
    const report = JSON.parse(json.stdout);
    const { retry, retry_after_ms, data } = refusal.expect;
    assert.deepEqual(report.refusals[0].detail, {
      code: refusal.body.error, status: refusal.status, message: refusal.body.message,
      request_id: 'req_browser_fixture_01',
      ...(retry !== undefined ? { retry } : {}),
      ...(retry_after_ms !== undefined ? { retry_after_ms } : {}),
      ...(data ? { data } : {}),
    });
    assert.doesNotMatch(json.stdout + json.stderr, CANARY);
  });
}
