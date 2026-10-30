import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsk_97979518, through the real entry point: index.ts runs claim recovery
// before `init`, so a stored claim continuation is exchanged (one request)
// before the local starter is written. Init is offline only when there is no
// continuation record to recover.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const requests = [];
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/auth/temp-handoff/exchange') {
    res.statusCode = 410;
    return res.end(JSON.stringify({ ok: false, error: 'CLAIM_CLI_HANDOFF_EXPIRED', message: 'CLI continuation expired. `somewhere login` in this directory signs in.' }));
  }
  res.statusCode = 500;
  res.end(JSON.stringify({ ok: false, error: 'UNEXPECTED', message: 'no other request expected' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

const expiredAt = '2026-10-14T18:00:00.000Z';
const handoff = { project_id: 'proj_old_temp', verifier: 'old-verifier', handoff_id: 'cch_old' };
const stored = { token: 'smt_expired_temp', temporary: true, temp_expires_at: expiredAt,
  claim_url: 'https://somewhere.cloud/claim/old', user: { email: '', username: '' }, claim_handoff: handoff };

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'sw-init-expired-handoff-'));
  const cwd = join(base, 'app'), config = join(base, 'config');
  mkdirSync(cwd); mkdirSync(config);
  writeFileSync(join(config, 'config.json'), JSON.stringify(stored));
  return { base, cwd, config };
}

function run(apiUrl, { base, cwd, config }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'init', '--name', 'starter'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, HOME: base, USERPROFILE: base, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: apiUrl,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('expired temporary session + server-expired continuation: init scaffolds; only that dead record is dropped', async () => {
  requests.length = 0;
  const dirs = setup();
  const r = await run(`http://127.0.0.1:${server.address().port}/v1`, dirs);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(requests, ['POST /v1/auth/temp-handoff/exchange']);
  assert.match(r.stdout, new RegExp(`temporary workspace on this machine expired at ${expiredAt}\\. If you claimed it in the browser, \`somewhere login\``));
  assert.match(r.stdout, /Local starter written to /);
  assert.doesNotMatch(r.stdout + r.stderr, /CLI continuation expired|Temporary session expired\. Run/);
  assert.ok(existsSync(join(dirs.cwd, 'index.html')));
  const { claim_handoff: _dropped, ...rest } = stored;
  assert.deepEqual(JSON.parse(readFileSync(join(dirs.config, 'config.json'), 'utf8')), rest);
});

test('expired temporary session + unreachable API: claim record kept, init still scaffolds', async () => {
  // A listener that is closed before the run: connection refused, an unknown outcome.
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const dirs = setup();
  const r = await run(`http://127.0.0.1:${port}/v1`, dirs);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Local starter written to /);
  assert.ok(existsSync(join(dirs.cwd, 'index.html')));
  assert.deepEqual(JSON.parse(readFileSync(join(dirs.config, 'config.json'), 'utf8')), stored);
});
