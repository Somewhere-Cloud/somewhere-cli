// Project notices are advisory context fetched alongside the deploy, not before
// it: the deploy request no longer waits on the notices round trip
// (tsk_b0cb30bb; measured 0.1-0.9 s on the live path, up to its 3 s timeout).
// Both directions:
//   - a slow notices answer: the deploy request is sent before it arrives, and
//     the notice is still printed once, on stderr (stdout JSON stays clean);
//   - a failed deploy: the notice is still printed with the failure.
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
const PROJECT = 'proj_notices_alongside';
const NOTICE = { id: 'n1', severity: 'action_required', title: 'Rotate the stale key', action_hint: 'Run somewhere env rotate' };

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function deploy({ deployFails }) {
  const home = mkdtempSync(join(tmpdir(), 'sw-notices-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-notices-fixture-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_notices_alongside', user: { email: 'dev@example.com', username: 'dev' },
  }) + '\n');
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: PROJECT, name: 'n', subdomain: 'notices-app' }) + '\n');
  writeFileSync(join(dir, 'index.html'), '<html><body>notices alongside</body></html>\n');
  const clock = {};
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && path === `/v1/projects/${PROJECT}/notices`) {
        clock.noticesAsked = Date.now();
        return setTimeout(() => {
          clock.noticesAnswered = Date.now();
          sendJson(res, 200, { ok: true, data: { project_id: PROJECT, notices: [NOTICE] } });
        }, 1_500);
      }
      if (req.method === 'POST' && path === '/v1/deploy') {
        clock.deployAsked = Date.now();
        if (deployFails) return sendJson(res, 500, { ok: false, error: 'INTERNAL', message: 'deploy exploded' });
        return sendJson(res, 200, { ok: true, data: {
          project_id: PROJECT, version: 1, release_id: 'rel_1', active_release_id: 'rel_1',
          base_release_id: null, files_deployed: 1, has_functions: false, warnings: [],
          status: 'success', release_publish: true,
        } });
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const result = await run(['deploy', '--json', '--yes'], {
      cwd: dir,
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1` },
    });
    return { ...result, clock };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('the deploy request does not wait for project notices, and the notice still prints on stderr', async () => {
  const r = await deploy({ deployFails: false });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.clock.noticesAsked && r.clock.deployAsked && r.clock.noticesAnswered, JSON.stringify(r.clock));
  assert.ok(r.clock.deployAsked < r.clock.noticesAnswered, `deploy sent before the notices answer (${JSON.stringify(r.clock)})`);
  assert.equal((r.stderr.match(/Rotate the stale key/g) ?? []).length, 1, r.stderr);
  assert.doesNotMatch(r.stdout, /Rotate the stale key/, 'stdout JSON stays clean');
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(json.project_id ?? json.data?.project_id, PROJECT);
});

test('a failed deploy still shows the notice', async () => {
  const r = await deploy({ deployFails: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Rotate the stale key/);
});
