import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `auth set` saves a token only after the platform accepts it. Only an
// authentication refusal (HTTP 401) means the token is not valid; an outage,
// a non-JSON page, an unexpected status or a dropped connection says nothing
// about the token, and none of them may replace the stored login.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let reply = () => ({ status: 200, body: { ok: true, data: { email: 'dev@example.test', username: 'dev' } } });
const requests = [];
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
  const { status, body, type = 'application/json' } = reply(req);
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

const stored = { token: 'smt_stored_access', refresh_token: 'smtr_stored_refresh', user: { email: 'owner@example.test', username: 'owner' } };

function run(apiUrl, { config, stdin = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'sw-auth-set-'));
  const configDir = join(base, 'config');
  mkdirSync(configDir);
  if (config) writeFileSync(join(configDir, 'config.json'), JSON.stringify(config));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'auth', 'set'], { cwd: base, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: {
      ...process.env, HOME: base, SOMEWHERE_CONFIG_DIR: configDir, SOMEWHERE_API_URL: apiUrl,
      SOMEWHERE_TOKEN: stdin ? '' : 'smt_candidate', SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    if (stdin) child.stdin.end('smt_candidate\n');
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, out: stdout + stderr,
      config: existsSync(join(configDir, 'config.json')) ? JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) : null }));
  });
}
const api = () => `http://127.0.0.1:${server.address().port}/v1`;

for (const [name, fault] of [
  ['HTTP 500', { status: 500, body: { ok: false, error: 'INTERNAL', message: 'Internal error' } }],
  ['HTML 503', { status: 503, body: '<html>Service Unavailable</html>', type: 'text/html' }],
  ['HTTP 404', { status: 404, body: { ok: false, error: 'NOT_FOUND', message: 'Not found' } }],
]) {
  test(`${name} while verifying: not reported as an invalid token; nothing saved, stored login kept`, async () => {
    reply = () => fault;
    const result = await run(api(), { config: stored });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /Could not verify the token/);
    assert.doesNotMatch(result.out, /not valid|rejected/i);
    assert.deepEqual(result.config, stored);
  });
}

test('an unreachable API while verifying: not reported as an invalid token; nothing saved', async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const result = await run(`http://127.0.0.1:${port}/v1`, { config: stored });
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /Could not verify the token/);
  assert.doesNotMatch(result.out, /not valid|rejected/i);
  assert.deepEqual(result.config, stored);
});

for (const code of ['INVALID_API_KEY', 'API_KEY_EXPIRED']) {
  test(`a 401 ${code} is a rejected token; the stored login is neither refreshed nor replaced`, async () => {
    requests.length = 0;
    reply = () => ({ status: 401, body: { ok: false, error: code, message: 'Invalid API key' } });
    const result = await run(api(), { config: stored });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /Token is not valid/);
    assert.deepEqual(result.config, stored);
    assert.deepEqual(requests, ['GET /v1/auth/platform-me Bearer smt_candidate']);
  });
}

test('an accepted token is saved', async () => {
  reply = () => ({ status: 200, body: { ok: true, data: { email: 'dev@example.test', username: 'dev' } } });
  const result = await run(api());
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /Token saved\. Logged in as dev@example\.test/);
  assert.equal(result.config.token, 'smt_candidate');
});

const profileRefusal = {
  status: 401,
  body: { ok: false, error: 'AUTH_INVALID_CREDS', message: 'Invalid or expired platform token.' },
};

for (const stdin of [false, true]) {
  test(`a temporary deployment key is saved with its expiry and claim link via ${stdin ? 'stdin' : 'SOMEWHERE_TOKEN'}`, async () => {
    const expiresAt = '2030-01-01T00:00:00.000Z';
    const claimUrl = 'https://example.test/app/claim';
    requests.length = 0;
    reply = (req) => req.url === '/v1/auth/platform-me' ? profileRefusal : {
      status: 200,
      body: { ok: true, data: {
        account: { temporary_expires_at: expiresAt },
        needs_you: [{ kind: 'keep_apps', action: { url: claimUrl } }],
      } },
    };
    const result = await run(api(), { stdin });
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /Temporary workspace key saved\./);
    assert.doesNotMatch(result.out, /smt_candidate|example\.test/);
    assert.deepEqual(result.config, {
      token: 'smt_candidate', temporary: true, temp_expires_at: expiresAt, claim_url: claimUrl,
      user: { email: '', username: '' },
    });
    assert.deepEqual(requests, [
      'GET /v1/auth/platform-me Bearer smt_candidate',
      'GET /v1/account/overview Bearer smt_candidate',
    ]);
  });
}

test('a failed temporary account lookup preserves the stored login and reports the lookup error', async () => {
  reply = (req) => req.url === '/v1/auth/platform-me' ? profileRefusal : {
    status: 503,
    body: { ok: false, error: 'SERVICE_UNAVAILABLE', message: 'Account overview is unavailable.' },
  };
  const result = await run(api(), { config: stored });
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /Could not verify the token: Account overview is unavailable/);
  assert.doesNotMatch(result.out, /Invalid or expired/);
  assert.deepEqual(result.config, stored);
});
