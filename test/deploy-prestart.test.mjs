// `somewhere deploy` asks the platform to start the project's compile container the moment the target is known,
// before it packs and uploads (, root decision 2026-11-04). The call is never awaited: a fixture that
// holds the prestart answer until the deploy request ARRIVES proves the upload does not wait for it. Every
// outcome (an older platform's 404, an error, no answer at all) leaves the deploy and its output unchanged. A dry
// run and a temporary workspace send none.
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
const UUID = 'cccccccc-1111-4222-8333-444444444444';
const HOLD_MS = 3000;

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, [distIndex, ...args], { cwd, env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr, ms: Date.now() - started }));
  });
}
function fixture({ linked = true, login = true } = {}) {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-prestart-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-prestart-fixture-'));
  if (login) {
    mkdirSync(join(HOME, '.somewhere'), { recursive: true });
    writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_prestart', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
  }
  writeFileSync(join(dir, 'index.html'), '<html><body>prestart</body></html>\n');
  if (linked) writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: UUID, name: 'prestart', subdomain: 'prestart-site', source_base: { project_id: UUID, release_id: 'rel_live_3' } }, null, 2) + '\n');
  return { HOME, dir };
}
function sendJson(res, status, payload) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); }

/** prestart: 'held' answers 202 only once the deploy request has arrived (or HOLD_MS passes); '404' is an older
 *  platform; '500' an error; 'never' never answers. */
function server({ prestart = 'held' } = {}) {
  const log = []; const prestarts = []; const t0 = Date.now();
  let deployArrived; const deployArrival = new Promise((r) => { deployArrived = r; });
  const state = { deployBeforePrestartAnswer: null };
  const handler = (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (req.url.includes('/notices')) { sendJson(res, 200, { ok: true, data: { notices: [] } }); return; }
      log.push({ at: Date.now() - t0, req: `${req.method} ${req.url}` });
      if (req.method === 'POST' && req.url === '/v1/deploy/prestart') {
        prestarts.push(JSON.parse(body));
        if (prestart === 'never') return;
        if (prestart === '404') { sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: 'Not found' }); return; }
        if (prestart === '500') { sendJson(res, 500, { ok: false, error: 'INTERNAL_ERROR', message: 'prestart failed' }); return; }
        state.deployBeforePrestartAnswer = await Promise.race([deployArrival.then(() => true), new Promise((r) => setTimeout(() => r(false), HOLD_MS))]);
        sendJson(res, 202, { ok: true, data: { project_id: UUID, prestarted: true } });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/projects/')) {
        sendJson(res, 200, { ok: true, data: { id: UUID, name: 'prestart', subdomain: 'prestart-site', status: 'deployed' } });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/deploy/status')) {
        sendJson(res, 200, { ok: true, data: { published: true, active_release_id: 'rel_live_3', prod_version: 3 } });
        return;
      }
      if (req.method === 'POST' && (req.url === '/v1/deploy' || req.url === '/v1/deploy?dry_run=true')) {
        deployArrived();
        const parsed = JSON.parse(body);
        if (parsed.dry_run) { sendJson(res, 200, { ok: true, data: { dry_run: true, added: [], removed: [], modified: [], unchanged: 1 } }); return; }
        sendJson(res, 200, { ok: true, data: { version: 4, files: 1, url: 'https://prestart-site.somewhere.site', has_functions: false, release_id: 'rel_live_4', active_release_id: 'rel_live_4' } });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  };
  return { handler, log, prestarts, state, at: (r) => log.find((l) => l.req === r)?.at };
}
async function withServer(handler, fn) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${s.address().port}/v1`); } finally { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
}
const env = (f, apiUrl) => ({ HOME: f.HOME, USERPROFILE: f.HOME, SOMEWHERE_API_URL: apiUrl });

test('linked folder: the prestart goes out first and the upload never waits for its answer', async () => {
  const f = fixture(); const srv = server();
  await withServer(srv.handler, async (apiUrl) => {
    const r = await run(['deploy', '--json'], { cwd: f.dir, env: env(f, apiUrl) });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(srv.prestarts, [{ project_id: UUID }], 'exactly one prestart, for the linked project');
    assert.equal(srv.state.deployBeforePrestartAnswer, true, 'the deploy request arrived while the prestart answer was still held');
    assert.ok(srv.at('POST /v1/deploy/prestart') <= srv.at('POST /v1/deploy'), 'sent before the upload');
    assert.equal(JSON.parse(r.stdout).data?.version ?? JSON.parse(r.stdout).version, 4, 'the deploy output is the deploy response');
  });
});

test('--project <uuid>: one prestart for the named project, before the upload', async () => {
  const f = fixture({ linked: false }); const srv = server();
  await withServer(srv.handler, async (apiUrl) => {
    const r = await run(['deploy', '--project', UUID, '--yes', '--json'], { cwd: f.dir, env: env(f, apiUrl) });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(srv.prestarts, [{ project_id: UUID }]);
    assert.ok(srv.at('POST /v1/deploy/prestart') <= srv.at('POST /v1/deploy'));
  });
});

for (const outcome of ['404', '500']) {
  test(`a prestart answered ${outcome} (an older platform, or an error) changes nothing`, async () => {
    const f = fixture(); const srv = server({ prestart: outcome });
    await withServer(srv.handler, async (apiUrl) => {
      const r = await run(['deploy'], { cwd: f.dir, env: env(f, apiUrl) });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(srv.prestarts.length, 1);
      assert.doesNotMatch(r.stdout + r.stderr, /deploy\/prestart|NOT_FOUND|INTERNAL_ERROR|prestart failed/i, 'nothing about it is printed');
      assert.match(r.stdout, /Live at https:\/\/prestart-site\.somewhere\.site/);
    });
  });
}

test('a prestart that never answers neither blocks the deploy nor holds the process open', async () => {
  const f = fixture(); const srv = server({ prestart: 'never' });
  await withServer(srv.handler, async (apiUrl) => {
    const r = await run(['deploy', '--json'], { cwd: f.dir, env: env(f, apiUrl) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(srv.prestarts.length, 1);
    assert.ok(r.ms < 4000, `the CLI exited in ${r.ms} ms, well inside the prestart's own 5 s bound`);
  });
});

test('--dry-run sends no prestart (nothing compiles)', async () => {
  const f = fixture(); const srv = server();
  await withServer(srv.handler, async (apiUrl) => {
    await run(['deploy', '--dry-run', '--json'], { cwd: f.dir, env: env(f, apiUrl) });
    assert.deepEqual(srv.prestarts, []);
  });
});
