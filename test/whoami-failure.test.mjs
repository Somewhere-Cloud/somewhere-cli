import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// whoami exits non-zero whenever it cannot confirm the login (agents gate on
// it), but only a 401 is reported as a login problem. The success body is the
// platform's /v1/auth/whoami shape (worker/src/routes/auth-app.ts).
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const whoami = { user: { email: 'dev@example.test', name: null, username: 'dev', effective_tier: 'free' }, stats: { api_keys: 1, projects: 2 }, session: null };
let reply;
let whoamiHeaders = null;
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/v1/auth/whoami') whoamiHeaders = req.headers;
  const { status, body, type = 'application/json' } = path === '/v1/auth/whoami' ? reply()
    : path === '/v1/pricing' ? { status: 200, body: { ok: true, data: { tiers: [{ id: 'free', name: 'Free' }] } } }
    : path === '/v1/projects' ? { status: 200, body: { ok: true, data: { projects: [] } } }
    : { status: 404, body: { ok: false, error: 'NOT_FOUND', message: 'Not found' } };
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());
const stored = { token: 'smt_stored_access_key', user: { email: 'dev@example.test', username: 'dev' } };

function run(args) {
  const base = mkdtempSync(join(tmpdir(), 'sw-whoami-'));
  const configDir = join(base, 'config');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(stored));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'whoami', ...args], { cwd: base, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, HOME: base, SOMEWHERE_CONFIG_DIR: configDir, SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, out: stdout + stderr,
      config: JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) }));
  });
}

test('the platform whoami shape prints the account and its plan name', async () => {
  reply = () => ({ status: 200, body: { ok: true, data: whoami } });
  const result = await run([]);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /dev@example\.test {2}\(Free\)/);
  assert.match(result.out, /2 projects you own, 1 active key/);
  // A CI developer key saved with `auth set` (no refresh token) sends no client version header and
  // is never told to log in interactively: nothing about the request depends on a version.
  assert.deepEqual(Object.keys(whoamiHeaders).filter((name) => /version|client/i.test(name)), []);
  assert.doesNotMatch(result.out, /somewhere login/);
});

test('HTML 503 (untyped): still non-zero, but not reported as an expired login', async () => {
  reply = () => ({ status: 503, body: '<html>Service Unavailable</html>', type: 'text/html' });
  const text = await run([]);
  assert.equal(text.status, 1, text.out);
  assert.match(text.out, /Could not check this login/);
  assert.doesNotMatch(text.out, /token may be expired|somewhere login/);
  const json = await run(['--json']);
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).error, 'WHOAMI_UNAVAILABLE');
  assert.deepEqual(json.config, stored);
});

// A typed refusal is the platform's own diagnosis: print its code and message, never a guess.
for (const [name, status, code, message] of [
  ['out-of-date client (401)', 401, 'CLIENT_UPDATE_REQUIRED', 'This version of the Somewhere CLI is out of date. Access through this client version is revoked. Update with: npm i -g @somewhere-cloud/cli@latest, then run somewhere login.'],
  ['invalid key (401)', 401, 'INVALID_API_KEY', 'Invalid API key'],
  ['internal error (500)', 500, 'INTERNAL', 'Internal error'],
]) {
  test(`typed ${name}: text and --json print the server's code and message`, async () => {
    reply = () => ({ status, body: { ok: false, error: code, message } });
    const text = await run([]);
    assert.equal(text.status, 1, text.out);
    assert.ok(text.out.includes(`${code}: ${message}`), text.out);
    assert.doesNotMatch(text.out, /token may be expired/);
    const json = await run(['--json']);
    assert.equal(json.status, 1);
    assert.deepEqual(JSON.parse(json.stdout), { error: code, message });
    assert.deepEqual(json.config, stored, 'the stored login is never changed');
  });
}

test('an untyped 401 is still reported as a login problem', async () => {
  reply = () => ({ status: 401, body: { ok: false, message: 'Unauthorized' } });
  const result = await run(['--json']);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { error: 'WHOAMI_FAILED', message: 'Could not fetch account details — token may be expired. Run: somewhere login' });
  reply = () => ({ status: 401, body: 'Unauthorized', type: 'text/plain' });
  const text = await run([]);
  assert.match(text.out, /token may be expired\. Run: somewhere login/);
});
