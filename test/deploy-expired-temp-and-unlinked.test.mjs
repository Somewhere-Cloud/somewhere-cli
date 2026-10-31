import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  claim_url: 'https://somewhere.cloud/claim?token=swtc_old',
  user: { email: '', username: '' },
};
const link = { project_id: 'proj_old_temp', name: 'old-temp', subdomain: 'old-temp' };

test('expired temporary session + linked folder: explains expiry, mints nothing, sends nothing', async () => {
  requests.length = 0;
  const { app, configDir } = fixture({ config: expiredTemp, link });
  const r = await run(['deploy'], app, configDir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(`expired at ${expiredAt}, and this machine has no record of a claim`), r.stderr);
  assert.doesNotMatch(r.stderr, /without being claimed/);
  assert.match(r.stderr, /Nothing was deployed/);
  assert.match(r.stderr, /delete this folder's \.somewhere\.json, then run `somewhere deploy`/);
  // Someone who claimed the workspace is told to sign in BEFORE being told to delete the link.
  const claimAt = r.stderr.indexOf('If you claimed this workspace in the browser, sign in with `somewhere login`');
  assert.ok(claimAt >= 0 && claimAt < r.stderr.indexOf('.somewhere.json'), r.stderr);
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

test('expired temporary session + unlinked folder: one-line note, replaced only after a successful mint (tsk_97979518)', async () => {
  requests.length = 0;
  const { app, configDir } = fixture({ config: expiredTemp });
  const r = await run(['deploy'], app, configDir);
  // The stub refuses the proof-of-work challenge: an unknown failure.
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(`The temporary session on this machine expired at ${expiredAt}; starting a new one.`), r.stdout);
  assert.doesNotMatch(r.stdout + r.stderr, /Temporary session expired\. Run/);
  assert.deepEqual(requests, ['GET /auth/pow/challenge']);
  // Nothing was minted, so the stored session is left exactly as it was.
  assert.deepEqual(JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')), expiredTemp);
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
  assert.match(r.stderr, /somewhere init --link --project <name-or-id>/);
  assert.match(r.stderr, /somewhere deploy --project <name-or-id>/);
  assert.match(r.stderr, /somewhere projects/);
  assert.ok(!requests.some((x) => x.startsWith('POST')), `no create/deploy: ${requests.join(', ')}`);
});

test('only a passed expiry time counts as expired; a missing token alone does not', async () => {
  const { temporarySessionExpired } = await import(join(dirname(distIndex), 'commands', 'deploy.js'));
  const now = Date.now();
  assert.equal(temporarySessionExpired({ temp_expires_at: new Date(now - 1000).toISOString() }, now), true);
  assert.equal(temporarySessionExpired({ temp_expires_at: new Date(now + 3_600_000).toISOString() }, now), false, 'future expiry with no token is not expired');
  assert.equal(temporarySessionExpired({}, now), false);
  assert.equal(temporarySessionExpired({ temp_expires_at: 'not-a-date' }, now), false);
});
