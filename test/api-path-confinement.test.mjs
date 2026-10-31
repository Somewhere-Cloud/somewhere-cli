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

for (const path of ['../../etc', '/v1/../../etc', '/projects/%2e%2e/%2E%2E/admin', 'https://example.com/x', '//example.com/x', '/projects\\..\\admin', '/projects#frag', '/a/%2F/b']) {
  test(`refused before any request: ${path}`, async () => {
    const result = await run(['api', 'GET', path]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /Not sent:/);
    assert.deepEqual(requests, []);
  });
}

for (const [path, expected] of [['/projects?limit=5&status=active', '/v1/projects?limit=5&status=active'], ['/v1/projects', '/v1/projects'], ['projects/abc', '/v1/projects/abc'], ['/v1/fs/list?path=%2Fdocs%2Fa.txt', '/v1/fs/list?path=%2Fdocs%2Fa.txt']]) {
  test(`valid path keeps its route and query: ${path}`, async () => {
    const result = await run(['api', 'GET', path]);
    assert.equal(result.status, 0, result.out);
    assert.deepEqual(requests.map((r) => r.url), [expected]);
    assert.equal(requests[0].auth, 'Bearer smt_fixture');
  });
}
