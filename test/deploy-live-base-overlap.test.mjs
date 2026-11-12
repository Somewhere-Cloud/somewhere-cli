// `deploy --project <uuid>` from a folder with no recorded base: the live-base read (GET /deploy/status) starts beside
// the project resolve (GET /projects/<ref>) instead of after it. Its result is used only when the
// resolve confirms the same canonical id; every refusal, the base selection and the request bodies are unchanged.
// Held I/O against a local server: the resolve is held until the status read ARRIVES, so a serial client times out
// of the hold instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const UUID = 'aaaaaaaa-1111-4222-8333-444444444444';
const OTHER = 'bbbbbbbb-1111-4222-8333-444444444444';
const HOLD_MS = 1500;

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], { cwd, env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}
function writeLogin(home) {
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_live_base_overlap', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
}
function fixture(link) {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-live-base-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-live-base-fixture-'));
  writeLogin(HOME);
  writeFileSync(join(dir, 'index.html'), '<html><body>live base overlap</body></html>\n');
  if (link) writeFileSync(join(dir, '.somewhere.json'), JSON.stringify(link, null, 2) + '\n');
  return { HOME, dir };
}
function sendJson(res, status, payload) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); }

/** resolveAs: the canonical id the resolve answers (null = 404). The resolve is HELD until the status read arrives
 *  (or HOLD_MS passes); `overlapped` records which happened. */
function server({ resolveAs = UUID, statusFails = false, holdResolve = true, active = 'rel_live_7' } = {}) {
  const log = []; const bodies = []; const t0 = Date.now();
  let statusArrived; const statusArrival = new Promise((r) => { statusArrived = r; });
  const state = { overlapped: null };
  const handler = (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const at = Date.now() - t0;
      if (req.url.includes('/notices')) { sendJson(res, 200, { ok: true, data: { notices: [] } }); return; }
      log.push({ at, req: `${req.method} ${req.url}` });
      if (req.method === 'GET' && req.url.startsWith('/v1/deploy/status')) {
        statusArrived();
        if (statusFails) { sendJson(res, 500, { ok: false, error: 'INTERNAL_ERROR', message: 'status unavailable' }); return; }
        const id = new URL(req.url, 'http://x').searchParams.get('project_id');
        sendJson(res, 200, { ok: true, data: { published: true, active_release_id: `${active}:${id}`, prod_version: 7 } });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/projects/')) {
        if (holdResolve) {
          state.overlapped = await Promise.race([statusArrival.then(() => true), new Promise((r) => setTimeout(() => r(false), HOLD_MS))]);
        }
        if (resolveAs === null) { sendJson(res, 404, { ok: false, error: 'PROJECT_NOT_FOUND', message: 'Project not found.' }); return; }
        sendJson(res, 200, { ok: true, data: { id: resolveAs, name: 'overlap', subdomain: 'overlap-site', status: 'deployed' } });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        bodies.push(JSON.parse(body));
        sendJson(res, 200, { ok: true, data: { version: 8, files: 1, url: 'https://overlap-site.somewhere.site', has_functions: false, release_id: 'rel_live_8', active_release_id: 'rel_live_8' } });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  };
  return { handler, log, bodies, state, gets: () => log.filter((l) => l.req.startsWith('GET')).map((l) => l.req) };
}
async function withServer(handler, fn) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${s.address().port}/v1`); } finally { await new Promise((r) => s.close(r)); }
}
const deploy = (f, apiUrl, extra = []) => run(['deploy', '--project', ...extra, '--json'], { cwd: f.dir, env: { HOME: f.HOME, USERPROFILE: f.HOME, SOMEWHERE_API_URL: apiUrl } });

test('uuid --project, unlinked folder: the live-base read overlaps the resolve; same body and base as before', async () => {
  const f = fixture(); const srv = server();
  await withServer(srv.handler, async (apiUrl) => {
    const r = await deploy(f, apiUrl, [UUID]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(srv.state.overlapped, true, 'the status read arrived while the resolve was still held');
    // Concurrent: either may reach the server first; the overlap itself is proven by the hold above.
    assert.deepEqual([...srv.gets()].sort(), [`GET /v1/deploy/status?project_id=${UUID}`, `GET /v1/projects/${UUID}`], 'still exactly one resolve and one status read');
    assert.equal(srv.bodies.length, 1);
    assert.equal(srv.bodies[0].project_id, UUID);
    assert.equal(srv.bodies[0].base_release_id, `rel_live_7:${UUID}`, 'the declared base is the live release of the resolved id');
    assert.equal('force' in srv.bodies[0], false);
    const post = srv.log.find((l) => l.req === 'POST /v1/deploy').at;
    assert.ok(post < HOLD_MS, `upload started before the serial hold would have expired (${post} ms)`);
    assert.equal(existsSync(join(f.dir, '.somewhere.json')), false, 'an unlinked folder stays unlinked');
  });
});

test('the resolve answers a DIFFERENT canonical id: the early read is discarded and the base is read for the resolved id', async () => {
  const f = fixture(); const srv = server({ resolveAs: OTHER });
  await withServer(srv.handler, async (apiUrl) => {
    const r = await deploy(f, apiUrl, [UUID]);
    assert.equal(r.status, 0, r.stderr);
    const gets = srv.gets();
    assert.deepEqual([...gets.slice(0, 2)].sort(), [`GET /v1/deploy/status?project_id=${UUID}`, `GET /v1/projects/${UUID}`], 'the early read beside the resolve');
    assert.equal(gets[2], `GET /v1/deploy/status?project_id=${OTHER}`, 'then the serial read for the RESOLVED id');
    const at = (r) => srv.log.find((l) => l.req === r).at;
    assert.ok(at(`GET /v1/deploy/status?project_id=${OTHER}`) >= at(`GET /v1/projects/${UUID}`), 'and only after the resolve');
    assert.equal(gets.length, 3);
    assert.equal(srv.bodies[0].project_id, OTHER);
    assert.equal(srv.bodies[0].base_release_id, `rel_live_7:${OTHER}`, 'never the early read of the unconfirmed id');
  });
});

test('an unresolvable uuid: no base declared (the deploy names the real error), exactly as before', async () => {
  const f = fixture(); const srv = server({ resolveAs: null });
  await withServer(srv.handler, async (apiUrl) => {
    await deploy(f, apiUrl, [UUID]);
    assert.equal(srv.bodies.length <= 1, true);
    if (srv.bodies.length) assert.equal('base_release_id' in srv.bodies[0], false, 'no base from the discarded early read');
  });
});

test('a failing live-base read leaves the base undeclared, as before, with no unhandled rejection', async () => {
  const f = fixture(); const srv = server({ statusFails: true });
  await withServer(srv.handler, async (apiUrl) => {
    const r = await deploy(f, apiUrl, [UUID]);
    assert.equal(srv.bodies.length, 1, r.stderr);
    assert.equal('base_release_id' in srv.bodies[0], false);
    assert.doesNotMatch(r.stderr, /unhandled|UnhandledPromiseRejection/i);
  });
});

test('a folder linked to a DIFFERENT project is still refused before any upload', async () => {
  const f = fixture({ project_id: OTHER, name: 'other', subdomain: 'other-site' }); const srv = server();
  await withServer(srv.handler, async (apiUrl) => {
    const r = await deploy(f, apiUrl, [UUID]);
    assert.equal(r.status, 1);
    assert.equal(srv.bodies.length, 0, 'nothing uploaded');
  });
});

test('--force, a slug ref and a linked folder with a recorded base keep their exact serial/no-read behaviour', async () => {
  // --force: no live-base read at all.
  { const f = fixture(); const srv = server({ holdResolve: false });
    await withServer(srv.handler, async (apiUrl) => {
      const r = await run(['deploy', '--project', UUID, '--force', '--yes', '--json'], { cwd: f.dir, env: { HOME: f.HOME, USERPROFILE: f.HOME, SOMEWHERE_API_URL: apiUrl } });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(srv.gets(), [`GET /v1/projects/${UUID}`]);
    }); }
  // A slug: the status read waits for the resolve (serial, as before).
  { const f = fixture(); const srv = server();
    await withServer(srv.handler, async (apiUrl) => {
      const r = await deploy(f, apiUrl, ['overlap-site']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(srv.state.overlapped, false, 'no early read for a slug');
      assert.deepEqual(srv.gets(), ['GET /v1/projects/overlap-site', `GET /v1/deploy/status?project_id=${UUID}`]);
    }); }
  // Linked to the same project with a recorded base: no status read.
  { const f = fixture({ project_id: UUID, name: 'overlap', subdomain: 'overlap-site', source_base: { project_id: UUID, release_id: 'rel_folder' } });
    const srv = server({ holdResolve: false });
    await withServer(srv.handler, async (apiUrl) => {
      const r = await deploy(f, apiUrl, [UUID]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(srv.gets().some((g) => g.includes('/deploy/status')), false, 'the folder base wins; no live read');
      assert.equal(srv.bodies[0].base_release_id, 'rel_folder');
    }); }
});
