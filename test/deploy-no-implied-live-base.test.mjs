// A folder with no record of deploying or pulling a live app does not get that app's live
// release as its base (tsk_2807e024), so a blank starter or an unrelated folder cannot replace
// it. The fixture platform applies the real base rule (worker/src/utils/source-base.ts
// decideLiveDeployBase): a live app accepts only its current release as base, or force.
// Every ordinary path still deploys in one command; the one that changes is named last.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const PROJECT = '3f2b6c1e-8a4d-4f5e-9b7a-1c2d3e4f5a6b';

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-implied-base-home-'));
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  writeFileSync(join(dir, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_implied_base', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
  return dir;
}

function folder(html = '<html><body>app</body></html>\n') {
  const dir = mkdtempSync(join(tmpdir(), 'sw-implied-base-app-'));
  writeFileSync(join(dir, 'index.html'), html);
  return dir;
}

/** One project on a fixture platform that refuses exactly what the real platform refuses. */
function platform({ live = null } = {}) {
  const state = { active: live, version: live ? 7 : 0, files: live ? { 'index.html': '<html><body>live app</body></html>\n' } : {} };
  const deploys = []; const reads = [];
  const send = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  const handler = (req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET') reads.push(url.pathname);
      if (req.method === 'POST' && url.pathname === '/v1/projects') {
        return send(res, 200, { ok: true, data: { id: PROJECT, name: 'implied', subdomain: 'implied-site', status: 'created' } });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/projects/')) {
        return send(res, 200, { ok: true, data: { id: PROJECT, name: 'implied', subdomain: 'implied-site', status: state.active ? 'deployed' : 'created' } });
      }
      if (req.method === 'GET' && url.pathname === '/v1/deploy/status') {
        return send(res, 200, { ok: true, data: { published: !!state.active, active_release_id: state.active, prod_version: state.active ? state.version : null } });
      }
      if (req.method === 'GET' && url.pathname === '/v1/deploy/source') {
        return send(res, 200, { ok: true, data: {
          project_id: PROJECT, env: 'prod', version: state.version, active_release_id: state.active,
          static_files: state.files, binary_files: {}, functions: {},
          counts: { static_files: Object.keys(state.files).length, binary_files: 0, functions: 0 },
        } });
      }
      if (req.method === 'POST' && url.pathname === '/v1/deploy') {
        const body = JSON.parse(raw);
        deploys.push(body);
        const hasBase = Object.prototype.hasOwnProperty.call(body, 'base_release_id');
        if (body.force !== true) {
          if (state.active && hasBase && body.base_release_id === null) {
            return send(res, 409, { ok: false, error: 'STALE_RELEASE_BASE', message: 'This deploy was prepared from an empty project, but the project already has published source. Nothing was changed.', data: { base_release_id: null, active_release_id: state.active, changed_files: [] } });
          }
          if (state.active && hasBase && body.base_release_id !== state.active) {
            return send(res, 409, { ok: false, error: 'STALE_RELEASE_BASE', message: 'Live is newer. Nothing was changed.', data: { base_release_id: body.base_release_id, active_release_id: state.active, changed_files: ['index.html'] } });
          }
          if (state.active && !hasBase) {
            return send(res, 400, { ok: false, error: 'BASE_REQUIRED', message: 'A live deploy must say which source it was prepared from: the base_release_id returned when this project was read or last deployed, or force: true for a deliberate overwrite. Nothing was changed.', data: {} });
          }
        }
        state.version += 1; state.active = `rel_${state.version}`;
        state.files = { ...(body.files ?? {}) };
        return send(res, 200, { ok: true, data: { version: state.version, files: Object.keys(state.files).length, url: 'https://implied-site.somewhere.site', has_functions: false, release_id: state.active, active_release_id: state.active } });
      }
      return send(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  };
  return { handler, state, deploys, reads };
}

async function withPlatform(p, fn) {
  const server = createServer(p.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}/v1`); } finally { await new Promise((r) => server.close(r)); }
}

const linkOf = (dir) => JSON.parse(readFileSync(join(dir, '.somewhere.json'), 'utf8'));
const show = (r) => `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`;

test('first deploy of a new app, then a redeploy from the same folder: both go live with no extra step', async () => {
  const p = platform();
  const HOME = home(); const app = folder();
  await withPlatform(p, async (api) => {
    const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: api };
    const first = await run(['deploy', '--new', '--json'], { cwd: app, env });
    assert.equal(first.status, 0, show(first));
    assert.equal(p.deploys[0].base_release_id, null, 'a new app is deployed from genesis');
    assert.equal(linkOf(app).source_base.release_id, 'rel_1', 'the folder records the release it deployed');

    writeFileSync(join(app, 'index.html'), '<html><body>app v2</body></html>\n');
    const again = await run(['deploy', '--json'], { cwd: app, env });
    assert.equal(again.status, 0, show(again));
    assert.equal(p.deploys[1].base_release_id, 'rel_1', 'the redeploy names the release this folder deployed');
    assert.equal(p.state.active, 'rel_2');
  });
});

test('redeploy after somewhere pull: the pulled folder deploys with no extra step', async () => {
  const p = platform({ live: 'rel_7' });
  const HOME = home(); const root = mkdtempSync(join(tmpdir(), 'sw-implied-base-pull-'));
  await withPlatform(p, async (api) => {
    const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: api };
    const pulled = await run(['pull', PROJECT, '--out', 'app'], { cwd: root, env });
    assert.equal(pulled.status, 0, show(pulled));
    const app = join(root, 'app');
    assert.equal(linkOf(app).source_base.release_id, 'rel_7', 'pull records the live release it downloaded');
    writeFileSync(join(app, 'index.html'), '<html><body>edited after pull</body></html>\n');
    const deployed = await run(['deploy', '--json'], { cwd: app, env });
    assert.equal(deployed.status, 0, show(deployed));
    assert.equal(p.deploys[0].base_release_id, 'rel_7');
    assert.equal(p.state.active, 'rel_8');
  });
});

test('a fresh clone of the builder\'s repo that contains .somewhere.json deploys with no extra step, with or without --project', async () => {
  const p = platform();
  const HOME = home(); const original = folder();
  await withPlatform(p, async (api) => {
    const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: api };
    assert.equal((await run(['deploy', '--new', '--json'], { cwd: original, env })).status, 0);
    // A clone holds the committed files; .somewhere/ (local caches) is gitignored by the starter.
    const clone = mkdtempSync(join(tmpdir(), 'sw-implied-base-clone-'));
    cpSync(original, clone, { recursive: true });
    rmSync(join(clone, '.somewhere'), { recursive: true, force: true });
    const plain = await run(['deploy', '--json'], { cwd: clone, env });
    assert.equal(plain.status, 0, show(plain));
    assert.equal(p.deploys[1].base_release_id, 'rel_1', 'the committed record is the base');
    const clone2 = mkdtempSync(join(tmpdir(), 'sw-implied-base-clone2-'));
    cpSync(clone, clone2, { recursive: true });
    rmSync(join(clone2, '.somewhere'), { recursive: true, force: true });
    const named = await run(['deploy', '--project', PROJECT, '--json'], { cwd: clone2, env });
    assert.equal(named.status, 0, show(named));
    assert.equal(p.deploys[2].base_release_id, 'rel_2', 'the record (updated by the last deploy) is the base; no live read is substituted');
  });
});

test('an unlinked folder naming a project with no published source deploys its first version with no extra step', async () => {
  const p = platform();
  const HOME = home(); const app = folder();
  await withPlatform(p, async (api) => {
    const r = await run(['deploy', '--project', PROJECT, '--json'], { cwd: app, env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: api } });
    assert.equal(r.status, 0, show(r));
    assert.equal(p.deploys[0].base_release_id, null);
  });
});

test('a folder with no record (a blank starter, or a clone without .somewhere.json) cannot replace a live app; the refusal names pull and --force, and --force replaces it', async () => {
  const p = platform({ live: 'rel_7' });
  const HOME = home(); const blank = folder('<html><body>blank starter</body></html>\n');
  await withPlatform(p, async (api) => {
    const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: api };
    const refused = await run(['deploy', '--project', PROJECT], { cwd: blank, env });
    assert.equal(refused.status, 1, show(refused));
    assert.equal('base_release_id' in p.deploys[0], false, 'the live release is never claimed as this folder\'s base');
    assert.equal(p.state.active, 'rel_7', 'the live app is unchanged');
    assert.match(refused.stderr, /already live, and this folder has no record of deploying or pulling it/);
    assert.match(refused.stderr, new RegExp(`somewhere pull ${PROJECT} --out <fresh-folder>`));
    assert.match(refused.stderr, new RegExp(`somewhere deploy --project ${PROJECT} --force --yes`));
    assert.equal(existsSync(join(blank, '.somewhere.json')), false, 'nothing is linked');

    const json = await run(['deploy', '--project', PROJECT, '--json'], { cwd: blank, env });
    assert.equal(json.status, 1);
    assert.equal(JSON.parse(json.stdout).error, 'BASE_REQUIRED');

    const forced = await run(['deploy', '--project', PROJECT, '--force', '--yes', '--json'], { cwd: blank, env });
    assert.equal(forced.status, 0, show(forced));
    assert.equal(p.deploys.at(-1).force, true);
    assert.equal(p.state.active, 'rel_8', 'the deliberate overwrite replaces the live app');
  });
});
