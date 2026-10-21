import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsk_8a68dfa2 items 14 and 15: both answers come from this machine's own
// record, so the stub API must see no request at all — no proof-of-work
// mint, no project lookup, no auto-create.
const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const requests = [];
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: 'UNEXPECTED', message: 'no request expected' }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function run(args, cwd, configDir) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, SOMEWHERE_API_URL: apiUrl, SOMEWHERE_CONFIG_DIR: configDir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function fixture({ config, link }) {
  const root = mkdtempSync(join(tmpdir(), 'sw-expired-unlinked-'));
  const configDir = join(root, 'config');
  const app = join(root, 'app');
  mkdirSync(configDir);
  mkdirSync(app);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(config));
  writeFileSync(join(app, 'index.html'), '<html><body>hi</body></html>\n');
  if (link) writeFileSync(join(app, '.somewhere.json'), JSON.stringify(link));
  return { app, configDir };
}

const expiredAt = new Date(Date.now() - 3_600_000).toISOString();
const expiredTemp = {
  token: 'smt_expired_temp',
  temporary: true,
  temp_expires_at: expiredAt,
  claim_url: 'https://somewhere.tech/claim?token=swtc_old',
  user: { email: '', username: '' },
};
const link = { project_id: 'proj_old_temp', name: 'old-temp', subdomain: 'old-temp' };

test('expired temporary session + linked folder: explains expiry, mints nothing, sends nothing', async () => {
  requests.length = 0;
  const { app, configDir } = fixture({ config: expiredTemp, link });
  const r = await run(['deploy'], app, configDir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(`expired at ${expiredAt} without being claimed`), r.stderr);
  assert.match(r.stderr, /Nothing was deployed/);
  assert.match(r.stderr, /delete this folder's \.somewhere\.json, then run `somewhere deploy`/);
  assert.match(r.stderr, /somewhere init --bare --name <name>/);
  assert.doesNotMatch(r.stdout + r.stderr, /Project not found|proof-of-work|proj_old_temp/i);
  assert.deepEqual(requests, []);
});

test('expired temporary session + linked folder, --json: structured, no request', async () => {
  requests.length = 0;
  const { app, configDir } = fixture({ config: expiredTemp, link });
  const r = await run(['deploy', '--json'], app, configDir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'TEMPORARY_SESSION_EXPIRED');
  assert.equal(out.temp_expires_at, expiredAt);
  assert.deepEqual(requests, []);
});

test('signed in, nothing linked: names the one-command recoveries and creates nothing', async () => {
  requests.length = 0;
  const { app, configDir } = fixture({
    config: { token: 'smt_account', user: { email: 'dev@example.com', username: 'dev' } },
  });
  const r = await run(['deploy'], app, configDir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /No project is linked to this folder/);
  assert.match(r.stderr, /somewhere init --bare --name <name>/);
  assert.match(r.stderr, /somewhere link --project <name-or-id>/);
  assert.match(r.stderr, /somewhere deploy --project <name-or-id>/);
  assert.match(r.stderr, /somewhere projects/);
  assert.ok(!requests.some((x) => x.startsWith('POST')), `no create/deploy: ${requests.join(', ')}`);
});
