import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every formatter prints a typed server error's code and message (tsk_224b77a0): the top-level
// handler (text and --json), a command with its own failure printer (fs), the MCP-tool path
// (`call`, text and --json), and `mcp doctor`. Network failures name their real cause.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const CODE = 'CLIENT_UPDATE_REQUIRED';
const MESSAGE = 'This version of the Somewhere CLI is out of date. Update with: npm i -g @somewhere-cloud/cli@latest, then run somewhere login.';

const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const mcp = req.url.startsWith('/mcp');
    res.writeHead(mcp ? 410 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(mcp
      ? { jsonrpc: '2.0', id: null, error: { code: -32000, message: MESSAGE, data: { error: CODE } } }
      : { ok: false, error: CODE, message: MESSAGE }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

function run(args, base = `http://127.0.0.1:${server.address().port}`) {
  const home = mkdtempSync(join(tmpdir(), 'sw-typed-fmt-'));
  mkdirSync(join(home, '.somewhere'));
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_stored', user: { email: 'fmt@example.test' } }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: home, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, HOME: home, SOMEWHERE_CONFIG_DIR: '', SOMEWHERE_API_URL: `${base}/v1`, SOMEWHERE_MCP_URL: `${base}/mcp`,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, out: stdout + stderr }));
  });
}

for (const args of [['projects'], ['fs', 'ls', '--project', 'p'], ['call', 'project_list', '{}']]) {
  test(`somewhere ${args.join(' ')}: text prints the code and the message`, async () => {
    const { status, out } = await run(args);
    assert.equal(status, 1, out);
    assert.ok(out.includes(MESSAGE), out);
    assert.match(out, /code CLIENT_UPDATE_REQUIRED/);
    assert.doesNotMatch(out, /token may be expired|Streamable HTTP error/);
  });
}

for (const args of [['projects', '--json'], ['call', 'project_list', '{}', '--json']]) {
  test(`somewhere ${args.join(' ')}: --json keeps the server's code and message`, async () => {
    const { status, stdout } = await run(args);
    assert.equal(status, 1);
    const body = JSON.parse(stdout);
    assert.equal(body.error, CODE);
    assert.equal(body.message, MESSAGE);
  });
}

test('mcp doctor prints the typed refusal for the token check and the MCP initialize, and does not prescribe a login', async () => {
  const { out } = await run(['mcp', 'doctor']);
  assert.ok(out.includes(`Token check refused: ${CODE}: ${MESSAGE}`), out);
  assert.match(out, /answered HTTP 410 CLIENT_UPDATE_REQUIRED: This version of the Somewhere CLI is out of date/);
  assert.doesNotMatch(out, /fix: somewhere login/);
});

test('a network failure on the MCP-tool path names the host and the cause, not a bare "fetch failed"', async () => {
  const dead = createServer();
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((resolve) => dead.close(resolve));
  const { status, out } = await run(['call', 'project_list', '{}'], base);
  assert.equal(status, 1);
  const host = base.replace('http://', '').replace(/[.]/g, '\\.');
  assert.match(out, new RegExp(`Could not reach ${host} \\(ECONNREFUSED`));
  assert.match(out, new RegExp(`add ${host}, or run the command in your own terminal`));
  assert.doesNotMatch(out, /^✗ fetch failed$/m);
});
