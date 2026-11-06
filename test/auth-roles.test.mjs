import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `somewhere auth roles grant|revoke|list` (tsk_8cdcca1d): one platform call each, to
// /v1/auth/app-roles[/grant|/revoke], with the developer key; an address becomes `email`,
// anything else `user_id`; the project comes from --project or the linked folder; a
// platform refusal is the command's error with its code.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const sourceIndex = join(repoRoot, 'src', 'index.ts');

function run(args, { env, cwd = repoRoot }) {
  return new Promise((resolvePromise) => {
    const sourceRunner = process.env.SOMEWHERE_TEST_SOURCE_RUNNER;
    const child = spawn(sourceRunner ?? process.execPath, sourceRunner ? [sourceIndex, ...args] : [distIndex, ...args], {
      cwd,
      env: { ...process.env, ...env, SOMEWHERE_NO_NOTIFICATIONS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.end('');
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function home(config) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-auth-roles-home-'));
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  writeFileSync(join(dir, '.somewhere', 'config.json'), JSON.stringify(config) + '\n');
  return dir;
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try { return await fn(`http://127.0.0.1:${port}/v1`); } finally { await new Promise((resolvePromise) => server.close(resolvePromise)); }
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

const readBody = (req) => new Promise((resolvePromise) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolvePromise(b ? JSON.parse(b) : null)); });

test('grant by address: one POST /auth/app-roles/grant with email, role and the project from --project', async () => {
  const calls = [];
  await withServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: await readBody(req) });
    json(res, 201, { ok: true, data: { user_id: 'u1', email: 'ann@example.test', email_verified: false, role: 'staff', granted_by: 'developer', grant_source: 'platform_admin', created_at: 1, already_granted: false } });
  }, async (base) => {
    const r = await run(['auth', 'roles', 'grant', 'ann@example.test', 'staff', '--project', 'my-app'], { env: { HOME: home({ token: 'smt_fixture' }), SOMEWHERE_API_URL: base } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/v1/auth/app-roles/grant');
    assert.equal(calls[0].auth, 'Bearer smt_fixture');
    assert.deepEqual(calls[0].body, { project_id: 'my-app', email: 'ann@example.test', role: 'staff' });
    assert.match(r.stdout, /ann@example\.test \(u1\) now holds the staff role/);
    assert.match(r.stdout, /not verified/);
  });
});

test('grant by user id uses user_id; a repeat is reported as already held; --json prints the grant', async () => {
  const bodies = [];
  await withServer(async (req, res) => {
    bodies.push(await readBody(req));
    json(res, 200, { ok: true, data: { user_id: 'u1', email: 'ann@example.test', email_verified: true, role: 'staff', granted_by: 'developer', grant_source: 'platform_admin', created_at: 1, already_granted: true } });
  }, async (base) => {
    const env = { HOME: home({ token: 'smt_fixture' }), SOMEWHERE_API_URL: base };
    const r = await run(['auth', 'roles', 'grant', 'u1', 'staff', '-p', 'my-app'], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(bodies[0], { project_id: 'my-app', user_id: 'u1', role: 'staff' });
    assert.match(r.stdout, /already holds the staff role/);
    const j = await run(['auth', 'roles', 'grant', 'u1', 'staff', '-p', 'my-app', '--json'], { env });
    assert.equal(j.status, 0, j.stderr);
    assert.equal(JSON.parse(j.stdout).already_granted, true);
  });
});

test('revoke: POST /auth/app-roles/revoke; revoked:false says nothing changed', async () => {
  let n = 0;
  await withServer(async (req, res) => {
    await readBody(req);
    assert.equal(req.url, '/v1/auth/app-roles/revoke');
    json(res, 200, { ok: true, data: { user_id: 'u1', email: 'ann@example.test', role: 'staff', revoked: n++ === 0 } });
  }, async (base) => {
    const env = { HOME: home({ token: 'smt_fixture' }), SOMEWHERE_API_URL: base };
    const a = await run(['auth', 'roles', 'revoke', 'ann@example.test', 'staff', '-p', 'my-app'], { env });
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /no longer holds the staff role/);
    const b = await run(['auth', 'roles', 'revoke', 'ann@example.test', 'staff', '-p', 'my-app'], { env });
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /did not hold the staff role; nothing changed/);
  });
});

test('list: GET /auth/app-roles with filters, follows next_cursor, prints every holder and the declared roles', async () => {
  const urls = [];
  await withServer(async (req, res) => {
    urls.push(req.url);
    const page = urls.length === 1
      ? { items: [{ user_id: 'u1', email: 'ann@example.test', email_verified: false, role: 'staff', granted_by: 'developer', grant_source: 'platform_admin', created_at: 1 }], next_cursor: 'c2', declared_roles: ['staff'] }
      : { items: [{ user_id: 'u2', email: 'bob@example.test', email_verified: true, role: 'staff', granted_by: 'u9', grant_source: 'platform_admin', created_at: 2 }], next_cursor: null, declared_roles: ['staff'] };
    json(res, 200, { ok: true, data: page });
  }, async (base) => {
    const r = await run(['auth', 'roles', 'list', '-p', 'my-app', '--role', 'staff', '--user', 'ann@example.test'], { env: { HOME: home({ token: 'smt_fixture' }), SOMEWHERE_API_URL: base } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(urls.length, 2, 'both pages were read');
    const first = new URL(`http://x${urls[0]}`);
    assert.equal(first.pathname, '/v1/auth/app-roles');
    assert.equal(first.searchParams.get('project_id'), 'my-app');
    assert.equal(first.searchParams.get('role'), 'staff');
    assert.equal(first.searchParams.get('email'), 'ann@example.test');
    assert.equal(first.searchParams.get('user_id'), null);
    assert.equal(new URL(`http://x${urls[1]}`).searchParams.get('cursor'), 'c2');
    assert.match(r.stdout, /ann@example\.test \(unverified\)/);
    assert.match(r.stdout, /bob@example\.test/);
    assert.match(r.stdout, /Declared roles: staff/);
  });
});

test('a platform refusal is the command error with its code, exit 1; --json prints the envelope', async () => {
  await withServer(async (req, res) => {
    await readBody(req);
    json(res, 404, { ok: false, error: 'USER_NOT_FOUND', message: 'No app user signed up with that exact address in this project.' });
  }, async (base) => {
    const env = { HOME: home({ token: 'smt_fixture' }), SOMEWHERE_API_URL: base };
    const r = await run(['auth', 'roles', 'grant', 'nobody@example.test', 'staff', '-p', 'my-app'], { env });
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /USER_NOT_FOUND/);
    const j = await run(['auth', 'roles', 'grant', 'nobody@example.test', 'staff', '-p', 'my-app', '--json'], { env });
    assert.equal(j.status, 1);
    assert.equal(JSON.parse(j.stdout).error, 'USER_NOT_FOUND');
  });
});

test('no project: refused before any request', async () => {
  let called = false;
  await withServer(async (req, res) => { called = true; json(res, 200, { ok: true, data: {} }); }, async (base) => {
    const r = await run(['auth', 'roles', 'list'], { env: { HOME: home({ token: 'smt_fixture' }), SOMEWHERE_API_URL: base }, cwd: mkdtempSync(join(tmpdir(), 'sw-auth-roles-unlinked-')) });
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /No project/);
    assert.equal(called, false);
  });
});
