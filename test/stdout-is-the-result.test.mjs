import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// stdout carries only the output a command was asked for; every notice, warning and progress
// line goes to stderr. Piping `somewhere api …` or any --json command into a JSON parser must
// work even when the CLI has something to warn about: here, a platform that announces another
// consumer contract than this CLI's (the drift warning every command can print).
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const { cliConsumerContract } = await import('../dist/lib/platform-contract.js');
const own = cliConsumerContract();
const drifted = `${own.version + 1}; digest=${'0'.repeat(64)}`;
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-sw-consumer-contract': drifted });
    res.end(JSON.stringify({ ok: true, data: req.url.startsWith('/v1/projects') ? { projects: [{ id: 'p1', name: 'one', subdomain: 'one', status: 'deployed' }] } : { fine: true } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

const base = mkdtempSync(join(tmpdir(), 'sw-stdout-'));
mkdirSync(join(base, 'config'));
writeFileSync(join(base, 'config', 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'dev@example.test', username: 'dev' } }));
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: base, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, SOMEWHERE_CONFIG_DIR: join(base, 'config'), SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// The first call records the drifted contract; from then on every command has a warning to print.
await run(['api', 'GET', '/v1/me']);

for (const args of [['api', 'GET', '/v1/projects'], ['api', 'GET', '/v1/projects', '--json'], ['project', 'list', '--json']]) {
  test(`stdout is only the result, warnings on stderr: somewhere ${args.join(' ')}`, async () => {
    const result = await run(args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout), `stdout is not JSON:\n${result.stdout}`);
    assert.match(result.stderr, /consumer contract/, 'the drift warning is still said, on stderr');
    assert.doesNotMatch(result.stdout, /Warning|consumer contract/);
  });
}

test('warn() writes to stderr, never stdout', async () => {
  const { warn } = await import('../dist/lib/output.js');
  const out = [], err = [];
  const log = console.log, error = console.error;
  console.log = (...v) => out.push(v.join(' ')); console.error = (...v) => err.push(v.join(' '));
  try { warn('a notice'); } finally { console.log = log; console.error = error; }
  assert.deepEqual(out, []);
  assert.match(err.join('\n'), /a notice/);
});
