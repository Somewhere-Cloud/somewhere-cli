import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `somewhere api` stays inside the configured API origin and /v1 prefix
// (pfb_8cef4606e9a3): traversal and absolute-URL input is refused before any
// request carries the token; valid relative paths and queries are unchanged.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const requests = [];
const server = createServer((req, res) => {
  // A bare `GET /` is this machine's local-port poller, never the CLI (a traversal would show as /etc).
  if (req.url !== '/') requests.push({ url: req.url, auth: req.headers.authorization });
  req.resume();
  req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: { fine: true } })); });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

function run(args) {
  requests.length = 0;
  const base = mkdtempSync(join(tmpdir(), 'sw-api-path-'));
  mkdirSync(join(base, 'config'));
  writeFileSync(join(base, 'config', 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'dev@example.test', username: 'dev' } }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: base, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, SOMEWHERE_CONFIG_DIR: join(base, 'config'), SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let out = '';
    child.stdout.on('data', (v) => out += v); child.stderr.on('data', (v) => out += v);
    child.on('close', (status) => resolve({ status, out }));
  });
}

// URL parsing strips ASCII tab/LF/CR, so "..<TAB>" would resolve as "..":
// literal control characters are refused before any request.
for (const path of ['../../etc', '/v1/../../etc', '/projects/%2e%2e/%2E%2E/admin', 'https://example.com/x', '//example.com/x', '/projects\\..\\admin', '/projects#frag', '/a/%2F/b',
  '/v1/..\t/etc', '/..\n/etc', '/.\r./etc', '/projects/.\t./admin', '/projects?limit=5\n']) {
  test(`refused before any request: ${JSON.stringify(path)}`, async () => {
    const result = await run(['api', 'GET', path]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /Not sent:/);
    assert.deepEqual(requests, []);
  });
}

for (const [path, expected] of [['/projects?limit=5&status=active', '/v1/projects?limit=5&status=active'], ['/v1/projects', '/v1/projects'], ['projects/abc', '/v1/projects/abc'],
  ['/v1/fs/list?path=%2Fdocs%2Fa.txt', '/v1/fs/list?path=%2Fdocs%2Fa.txt'], ['/v1', '/v1/'], ['/projects/my%20app/deploys?q=a%20b&x=..', '/v1/projects/my%20app/deploys?q=a%20b&x=..'],
  ['v1/projects?filter=a/../b', '/v1/projects?filter=a/../b']]) {
  test(`valid path keeps its route and query: ${path}`, async () => {
    const result = await run(['api', 'GET', path]);
    assert.equal(result.status, 0, result.out);
    assert.deepEqual(requests.map((r) => r.url), [expected]);
    assert.equal(requests[0].auth, 'Bearer smt_fixture');
  });
}

test('the final URL check refuses a path that would resolve outside the configured API base', async () => {
  const { normalizeApiPath } = await import('../dist/commands/api.js');
  assert.deepEqual(normalizeApiPath('/projects?limit=5', 'https://api.example.test/v1'), { path: '/projects?limit=5' });
  assert.match(normalizeApiPath('/..\t/etc', 'https://api.example.test/v1').error, /control characters/);
  // NUL cannot travel in argv, so it is checked here directly.
  assert.match(normalizeApiPath('/proj\u0000ects', 'https://api.example.test/v1').error, /control characters/);
  assert.match(normalizeApiPath('/x', 'https://api.example.test/v1').path, /^\/x$/);
});

// pfb_c1845661960e: an unsupported or malformed method is refused before any
// request, not reported as a network problem.
for (const method of ['TRACE', 'CONNECT', 'GE T', 'GET\r\nX-Injected: 1']) {
  test(`unsupported method refused before any request: ${JSON.stringify(method)}`, async () => {
    const result = await run(['api', method, '/projects']);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /is not a supported method/);
    assert.doesNotMatch(result.out, /NETWORK_ERROR|check your network/);
    assert.deepEqual(requests, []);
  });
}
test('lower-case supported methods still work', async () => {
  const result = await run(['api', 'get', '/projects']);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(requests.map((r) => r.url), ['/v1/projects']);
});
