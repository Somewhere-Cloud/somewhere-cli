import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformErrorIds } from '../dist/lib/output.js';

// tsk_c95a437d: a text-mode platform failure prints the code and request/trace ids, not only the message.
const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
let traceHeader = 'trace-4e1d2c3b5a69';
const server = createServer(async (req, res) => {
  for await (const _ of req);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Request-Id', 'req_8f2c1a9b77d0');
  res.setHeader('X-Trace-Id', traceHeader);
  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: 'PROJECT_NOT_FOUND', message: 'Project not found.' }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(() => server.close());
function run(args) {
  const root = mkdtempSync(join(tmpdir(), 'sw-textids-')); const cfg = join(root, 'cfg'); mkdirSync(cfg);
  writeFileSync(join(cfg, 'config.json'), JSON.stringify({ token: 'smt_test', user: { email: 'd@example.test', username: 'd' } }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distIndex, ...args], { cwd: root,
      env: { ...process.env, NO_COLOR: '1', SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}`, SOMEWHERE_CONFIG_DIR: cfg } });
    let out = ''; child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c));
    child.on('close', (status) => resolve({ status, out }));
  });
}

test('a text-mode platform failure names its code and ids', async () => {
  const r = await run(['db', 'query', 'SELECT 1', '--project', 'proj_7c1b2a9d4e']);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /code PROJECT_NOT_FOUND · request req_8f2c1a9b77d0 · trace trace-4e1d2c3b5a69/, r.out);
});

test('hostile or malformed ids are never printed; CLI-originated errors get no ids line', async () => {
  traceHeader = '-flag smt_CANARY';
  const r = await run(['db', 'query', 'SELECT 1', '--project', 'proj_7c1b2a9d4e']);
  assert.doesNotMatch(r.out, /CANARY|-flag/);
  assert.match(r.out, /code PROJECT_NOT_FOUND · request req_8f2c1a9b77d0\n/);
  traceHeader = 'trace-4e1d2c3b5a69';
  assert.equal(platformErrorIds(new Error('plain')), null);
  assert.equal(platformErrorIds(Object.assign(new Error('x'), { name: 'CliApiError', code: 'lower case' })), null);
});
