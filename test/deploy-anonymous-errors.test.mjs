import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Signed-out deploy against a local fixture of the public anonymous routes,
// shaped like the platform's own (worker/src/routes/auth-platform.ts:
// issueTemporaryPowChallenge, /temp-create; utils/errors errorResponse).
// pfb_011a9fd3f5f3: typed errors keep code, status, retry_after_ms and request
// ids; non-JSON bodies are named with their status; nothing is resent and no
// credential is sent to the public routes.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let challengeReply = null; // null: the real-shaped success
let createReply = null;
const requests = [];
const issued = new Map();
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = req.url.split('?')[0];
    requests.push({ method: req.method, path, auth: req.headers.authorization ?? null, body });
    const json = (status, payload, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `req_fixture_${status}`, 'x-trace-id': 'trace_fixture_1', ...headers }); res.end(JSON.stringify(payload)); };
    const raw = (status, text) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end(text); };
    const reply = (spec, fallback) => spec ? (spec.html ? raw(spec.status, spec.html) : json(spec.status, spec.body)) : fallback();
    if (path === '/v1/auth/pow/challenge') return reply(challengeReply, () => {
      const nonce = `tmpc_${issued.size + 1}`; issued.set(nonce, 4);
      json(200, { ok: true, data: { nonce, difficulty: 4, algorithm: 'sha256', input: `${nonce}:<suffix>`, expires_at: new Date(Date.now() + 6e5).toISOString(), ttl_seconds: 600 } });
    });
    if (path === '/v1/auth/temp-create') return reply(createReply, () => {
      const { nonce, suffix } = JSON.parse(body);
      const digest = createHash('sha256').update(`${nonce}:${suffix}`).digest();
      if (!issued.has(nonce) || digest[0] >> 4 !== 0) return json(400, { ok: false, error: 'INVALID_POW', message: 'Proof-of-work solution is invalid.' });
      const expires = new Date(Date.now() + 3 * 3600e3).toISOString();
      json(200, { ok: true, data: { user: { id: 'u_tmp', email: 'tmp@anon.invalid', is_anonymous: true, is_temporary: true, expires_at: expires },
        access_token: 'smt_tmp_fixture', key: 'smt_tmp_fixture', key_prefix: 'smt_tmp', key_id: 'key_tmp', scopes: ['projects', 'deploy'],
        expires_at: expires, ttl_seconds: 10800, claim_token: 'swtc_fixture', claim_url: 'https://somewhere.cloud/claim?token=swtc_fixture' } });
    });
    if (req.method === 'POST' && path === '/v1/projects') return json(200, { ok: true, data: { id: 'proj_anon', name: 'app-x1', subdomain: 'app-x1', slug: 'app-x1' } });
    if (path === '/v1/auth/temp-handoff/register') return json(201, { ok: true, data: { handoff_id: 'cch_fixture', expires_at: new Date(Date.now() + 3 * 3600e3).toISOString() } });
    if (req.method === 'POST' && path === '/v1/deploy') return json(200, { ok: true, data: { files: 1, url: 'https://app-x1.somewhere.site', version: 1, release_id: 'rel_1', has_functions: false, warnings: [] } });
    json(200, { ok: true, data: { notices: [] } });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

function run(args) {
  requests.length = 0;
  const base = mkdtempSync(join(tmpdir(), 'sw-anon-'));
  const app = join(base, 'app'), config = join(base, 'config');
  mkdirSync(app); mkdirSync(config);
  writeFileSync(join(app, 'index.html'), '<html><body>hi</body></html>\n');
  const url = `http://127.0.0.1:${server.address().port}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: `${url}/v1`, SOMEWHERE_MCP_URL: `${url}/mcp`, SOMEWHERE_RUNNER_URL: url,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr, savedSession: existsSync(join(config, 'config.json')) }));
  });
}
const publicCalls = () => requests.filter((r) => r.path.startsWith('/v1/auth/pow') || r.path === '/v1/auth/temp-create');

test('first anonymous deploy against the real-shaped routes goes live; no credential is sent to the public routes', async () => {
  challengeReply = null; createReply = null;
  const result = await run(['deploy', '--json']);
  assert.equal(result.status, 0, result.out);
  const out = JSON.parse(result.stdout);
  assert.equal(out.url, 'https://app-x1.somewhere.site');
  assert.equal(out.claim_url, 'https://somewhere.cloud/claim?token=swtc_fixture');
  assert.deepEqual(publicCalls().map((r) => [r.method, r.path, r.auth]), [['GET', '/v1/auth/pow/challenge', null], ['POST', '/v1/auth/temp-create', null]]);
  assert.equal(requests.find((r) => r.path === '/v1/deploy').auth, 'Bearer smt_tmp_fixture');
  assert.ok(result.savedSession);
});

for (const [name, spec, expected] of [
  ['429 RATE_LIMITED on the challenge', { status: 429, body: { ok: false, error: 'RATE_LIMITED', message: 'Too many temporary deploy requests from this IP; a later request can succeed.', retry: true, retry_after_ms: 3000 } },
    { error: 'RATE_LIMITED', retry: true, retry_after_ms: 3000, request_id: 'req_fixture_429' }],
  ['500 on the challenge', { status: 500, body: { ok: false, error: 'INTERNAL_ERROR', message: 'Something failed.' } }, { error: 'INTERNAL_ERROR', request_id: 'req_fixture_500' }],
  ['404 on the challenge', { status: 404, body: { ok: false, error: 'NOT_FOUND', message: 'Not found.' } }, { error: 'NOT_FOUND', request_id: 'req_fixture_404' }],
  ['TEMP_DEPLOYS_DISABLED 503', { status: 503, body: { ok: false, error: 'TEMP_DEPLOYS_DISABLED', message: 'Temporary deploys are currently disabled.', retry: false } }, { error: 'TEMP_DEPLOYS_DISABLED', retry: false }],
]) {
  test(`${name}: --json keeps the platform's code, retry fields and request id; sent once; nothing saved`, async () => {
    challengeReply = spec; createReply = null;
    const result = await run(['deploy', '--json']);
    assert.equal(result.status, 1, result.out);
    const out = JSON.parse(result.stdout);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(out[key], value, key);
    assert.notEqual(out.error, 'CLI_ERROR');
    assert.equal(publicCalls().length, 1, 'never resent');
    assert.equal(result.savedSession, false);
  });
}

for (const [name, spec, status] of [['HTML 502', { status: 502, html: '<html><body>Bad gateway</body></html>' }, 502], ['HTML 200', { status: 200, html: '<html><body>captive portal</body></html>' }, 200]]) {
  test(`${name} on the challenge: INVALID_RESPONSE with the HTTP status, not a JavaScript parse error`, async () => {
    challengeReply = spec; createReply = null;
    const json = await run(['deploy', '--json']);
    assert.equal(json.status, 1);
    const out = JSON.parse(json.stdout);
    assert.equal(out.error, 'INVALID_RESPONSE');
    assert.match(out.message, new RegExp(`Non-JSON response \\(${status}\\)`));
    const text = await run(['deploy']);
    assert.match(text.out, new RegExp(`\\[INVALID_RESPONSE, HTTP ${status}\\]`));
    assert.doesNotMatch(text.out, /Unexpected token|is not valid JSON/);
  });
}

test('INVALID_POW on temp-create keeps its code and status; no second challenge', async () => {
  challengeReply = null; createReply = { status: 400, body: { ok: false, error: 'INVALID_POW', message: 'Proof-of-work challenge is invalid or expired.' } };
  const result = await run(['deploy']);
  assert.equal(result.status, 1);
  assert.match(result.out, /Proof-of-work challenge is invalid or expired\. \[INVALID_POW, HTTP 400\]/);
  assert.equal(publicCalls().length, 2);
  assert.equal(result.savedSession, false);
});
