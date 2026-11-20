import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitDeployChecks, formatDeployChecksLine, parseChecksRead, DEPLOY_CHECKS_STILL_RUNNING } from '../dist/lib/deploy-checks.js';

const checks = { status: 'running', read: 'GET /v1/deploy/log?project_id=p1&version=3' };

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('the read named by the platform becomes the API path and query', () => {
  assert.deepEqual(parseChecksRead(checks.read), { path: '/deploy/log', query: { project_id: 'p1', version: '3' } });
  assert.equal(parseChecksRead('POST /v1/x'), null);
});

test('polls every 3 s until the access check settles and prints its sentence', async () => {
  const c = clock();
  const calls = [];
  const answers = [{ access_check: { status: 'pending', sentence: null } }, new Error('network'), { access_check: { status: 'checked', sentence: 'Only owners can read notes.', findings: [], checked_at: 'x' } }];
  const client = { call: async (method, path, body, query) => { calls.push({ method, path, query, at: c.now() }); const a = answers.shift(); if (a instanceof Error) throw a; return a; } };
  const check = await awaitDeployChecks(client, checks, c);
  assert.equal(check.status, 'checked');
  assert.deepEqual(calls.map(x => x.at), [0, 3000, 6000]);
  assert.deepEqual(calls[0], { method: 'GET', path: '/deploy/log', query: { project_id: 'p1', version: '3' }, at: 0 });
  assert.equal(formatDeployChecksLine(check), 'Checks: Only owners can read notes.');
});

test('stops at 45 s and says the check is still running', async () => {
  const c = clock();
  let n = 0;
  const client = { call: async () => { n += 1; return { access_check: { status: 'pending', sentence: null } }; } };
  const check = await awaitDeployChecks(client, checks, c);
  assert.equal(check.status, 'pending');
  assert.ok(c.now() <= 45_000 && n === 16, `${n} reads by ${c.now()} ms`);
  assert.equal(formatDeployChecksLine(check), DEPLOY_CHECKS_STILL_RUNNING);
  assert.match(DEPLOY_CHECKS_STILL_RUNNING, /^Checks: still running; .* shows the result\.$/);
  // Every read failing is the same: still running, never an error.
  const failing = { call: async () => { throw new Error('down'); } };
  assert.equal(formatDeployChecksLine(await awaitDeployChecks(failing, checks, clock())), DEPLOY_CHECKS_STILL_RUNNING);
});

test('an unavailable check prints its sentence too', () => {
  assert.equal(formatDeployChecksLine({ status: 'unavailable', sentence: 'The access check could not run.' }), 'Checks: The access check could not run.');
});

// End to end: a deploy whose answer carries checks prints the sentence (or puts access_check in --json), exit 0.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const PROJECT = 'aaaaaaaa-1111-4222-8333-666666666666';

test('a deploy with checks reads the log and reports the access check without changing the exit code', async () => {
  const HOME = mkdtempSync(join(process.env.TMPDIR, 'sw-checks-home-'));
  const dir = mkdtempSync(join(process.env.TMPDIR, 'sw-checks-app-'));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_checks', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
  writeFileSync(join(dir, 'index.html'), '<html><body>checks</body></html>\n');
  const reads = [];
  const send = (res, payload) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
  const settled = { status: 'unavailable', sentence: 'The access check could not run on this release.', findings: [], checked_at: '2026-11-20T00:00:00Z' };
  const s = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.includes('/notices')) return send(res, { ok: true, data: { notices: [] } });
      if (req.url.startsWith('/v1/deploy/status')) return send(res, { ok: true, data: { published: true, active_release_id: 'rel_old', prod_version: 2 } });
      if (req.url.startsWith('/v1/projects/')) return send(res, { ok: true, data: { id: PROJECT, name: 'p', subdomain: 'checks', status: 'deployed' } });
      if (req.method === 'POST' && req.url === '/v1/deploy') return send(res, { ok: true, data: {
        project_id: PROJECT, version: 3, url: 'https://checks.somewhere.site', release_id: 'rel_new', active_release_id: 'rel_new', status: 'success',
        checks: { status: 'running', read: `GET /v1/deploy/log?project_id=${PROJECT}&version=3` },
      } });
      if (req.url.startsWith('/v1/deploy/log')) {
        reads.push(req.url);
        return send(res, { ok: true, data: { access_check: reads.length % 2 === 1 ? { status: 'pending', sentence: null } : settled } });
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${s.address().port}/v1`;
  const run = (extra) => new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, 'deploy', '--project', PROJECT, ...extra], { cwd: dir, env: { ...process.env, HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => (stdout += c)); child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
  try {
    const human = await run([]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout + human.stderr, /^ *Checks: The access check could not run on this release\.$/m);
    assert.equal(reads[0], `/v1/deploy/log?project_id=${PROJECT}&version=3`);
    const json = await run(['--json']);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).access_check, settled);
  } finally { await new Promise((r) => s.close(r)); }
});
