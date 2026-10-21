// A deploy the CLI re-sent after its OWN timeout / lost connection may have
// gone live on the first attempt; a STALE_RELEASE_BASE answer to that retry
// must say so, never "NOT applied" (tsk_8a68dfa2 item 1). Both directions:
//   - first attempt times out, retry is refused stale → "may already have gone
//     live", JSON first_attempt_outcome: unknown, exit non-zero;
//   - first attempt answered by the platform with retry: true (it changed
//     nothing), retry refused stale → the existing "NOT applied" explanation;
//   - stale on the first attempt → the existing explanation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const PROJECT = 'proj_retry_stale';
const STALE = { ok: false, error: 'STALE_RELEASE_BASE', message: 'This deploy was prepared from release rel_old, but release rel_new is live now, so nothing was changed.',
  data: { base_release_id: 'rel_old', active_release_id: 'rel_new', changed_files: ['api/a.js'], history_unavailable: false } };

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], { cwd, env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}
const sendJson = (res, status, payload) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); };

async function deploy(firstAttempt, extraArgs = []) {
  const home = mkdtempSync(join(tmpdir(), 'sw-retry-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-retry-fixture-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_retry_stale', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: PROJECT, name: 'r', subdomain: 'retry-app', source_base: { release_id: 'rel_old' } }) + '\n');
  writeFileSync(join(dir, 'index.html'), '<html><body>retry</body></html>\n');
  let deploys = 0;
  const pending = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && path === `/v1/projects/${PROJECT}/notices`) return sendJson(res, 200, { ok: true, data: { project_id: PROJECT, notices: [] } });
      if (req.method === 'POST' && path === '/v1/deploy') {
        deploys++;
        if (deploys === 1 && firstAttempt === 'hang') { pending.push(res); return; } // the CLI times out
        if (deploys === 1 && firstAttempt === 'retryable') return sendJson(res, 500, { ok: false, error: 'DEPLOY_INTERNAL_ERROR', message: 'did not complete', retry: true });
        return sendJson(res, 409, STALE);
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const result = await run(['deploy', '--yes', ...extraArgs], {
      cwd: dir,
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1`, SOMEWHERE_DEPLOY_TIMEOUT_MS: '400' },
    });
    return { ...result, deploys };
  } finally {
    for (const res of pending) res.destroy();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

test('a retry after the CLI\'s own timeout that is refused stale says the first attempt may be live', async () => {
  const r = await deploy('hang');
  const out = r.stdout + r.stderr;
  assert.equal(r.deploys, 2, 'the deploy was re-sent once');
  assert.notEqual(r.status, 0);
  assert.match(out, /may already have gone live/);
  assert.doesNotMatch(out, /NOT applied/);
});

test('--json marks the first attempt outcome unknown', async () => {
  const r = await deploy('hang', ['--json']);
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(json.error, 'STALE_RELEASE_BASE');
  assert.equal(json.first_attempt_outcome, 'unknown');
  assert.equal(json.first_attempt_failure, 'TIMEOUT');
});

test('a retry after the platform\'s own retry:true keeps the NOT applied explanation', async () => {
  const r = await deploy('retryable');
  assert.equal(r.deploys, 2);
  assert.match(r.stdout + r.stderr, /NOT applied/);
  assert.doesNotMatch(r.stdout + r.stderr, /may already have gone live/);
});

test('stale on the first attempt keeps the NOT applied explanation', async () => {
  const r = await deploy('stale');
  assert.equal(r.deploys, 1);
  assert.match(r.stdout + r.stderr, /NOT applied/);
});
