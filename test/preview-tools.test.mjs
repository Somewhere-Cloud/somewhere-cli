import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Preview tools: the preview's users, managed test users and captured mail. Every tool request
// carries ONLY the preview's own credential, minted once under the developer's sign-in and kept
// owner-only in the CLI config directory, never in the project folder. A dead credential is
// forgotten and never replaced by the developer's sign-in.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const PROJECT = '00000000-0000-4000-8000-0000000000d4';
const SESSION = 'draft_dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CREDENTIAL = `swpt.${PROJECT}.${SESSION}.${'k'.repeat(43)}`;

function run(args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd, env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', SOMEWHERE_NO_UPDATE_CHECK: '1' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr, all: stdout + stderr }));
  });
}

async function fakePlatform() {
  const state = { requests: [], dead: false, users: [], mail: [{ id: 'm1', to: 'ada@example.com', subject: '[Preview] Your verification code', verification_code: '123456', magic_link: null, created_at: new Date().toISOString(), environment: 'preview', preview_session_id: SESSION }] };
  const json = (res, payload, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://local');
      const body = raw ? JSON.parse(raw) : null;
      const auth = req.headers.authorization ?? '';
      state.requests.push({ method: req.method, path: url.pathname, auth, body });
      if (url.pathname.endsWith('/notices')) return json(res, { ok: true, data: { notices: [] } });
      if (url.pathname === `/v1/projects/${PROJECT}/preview/tool-credential`) {
        if (auth !== 'Bearer smt_tools') return json(res, { ok: false, error: 'INVALID_API_KEY', message: 'no' }, 401);
        if (auth.startsWith('Bearer swpt.')) return json(res, { ok: false, error: 'PREVIEW_CREDENTIAL_NOT_ACCEPTED', message: 'no' }, 403);
        return json(res, { ok: true, data: { credential: CREDENTIAL, preview_session_id: body.preview_session_id } }, 201);
      }
      if (url.pathname.startsWith('/v1/preview-tools/')) {
        if (!auth.startsWith('Bearer swpt.')) return json(res, { ok: false, error: 'PREVIEW_CREDENTIAL_REQUIRED', message: 'Preview tools accept only a preview credential.' }, 401);
        if (state.dead) return json(res, { ok: false, error: 'PREVIEW_CREDENTIAL_INVALID', message: 'closed' }, 401);
        if (req.method === 'GET' && url.pathname === '/v1/preview-tools/users') return json(res, { ok: true, data: { preview_session_id: SESSION, users: state.users } });
        if (req.method === 'POST' && url.pathname === '/v1/preview-tools/users') {
          const user = { id: 'u-' + (state.users.length + 1), email: body.email ?? 'preview-1@tools.test.somewhere.site', email_verified: true, test: true };
          state.users.push(user);
          return json(res, { ok: true, data: { preview_session_id: SESSION, user, password: body.password ?? 'Pv-generated' } }, 201);
        }
        if (req.method === 'DELETE' && url.pathname.startsWith('/v1/preview-tools/users/')) {
          state.users = state.users.filter((u) => u.id !== decodeURIComponent(url.pathname.split('/').pop()));
          return json(res, { ok: true, data: { preview_session_id: SESSION, deleted: true } });
        }
        if (req.method === 'GET' && url.pathname === '/v1/preview-tools/mail') return json(res, { ok: true, data: { preview_session_id: SESSION, messages: state.mail.slice(0, Number(url.searchParams.get('limit'))) } });
      }
      return json(res, { ok: false, error: 'NOT_FOUND', message: req.method + ' ' + url.pathname }, 404);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { state, env: (home) => ({ HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1`, SOMEWHERE_MCP_URL: `http://127.0.0.1:${port}/mcp` }),
    close: () => new Promise((resolve) => server.close(resolve)) };
}

function folder({ withPreview = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sw-preview-tools-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-preview-tools-src-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_tools', user: { email: 'dev@example.com' } }) + '\n');
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: PROJECT, name: 'tools', subdomain: 'tools' }) + '\n');
  if (withPreview) {
    mkdirSync(join(dir, '.somewhere'), { recursive: true });
    writeFileSync(join(dir, '.somewhere', 'preview.json'), JSON.stringify({ project_id: PROJECT, preview_session_id: SESSION, preview_id: 'rel_candidate_D001', files: {}, saved_at: new Date().toISOString() }) + '\n');
  }
  return { home, dir };
}
const toolRequests = (state) => state.requests.filter((r) => r.path.startsWith('/v1/preview-tools/'));

test('preview tools mint the preview credential once, keep it private, and send only it', async () => {
  const platform = await fakePlatform();
  const { home, dir } = folder();
  const env = platform.env(home);
  try {
    const users = await run(['preview', 'users', '--json'], dir, env);
    assert.equal(users.status, 0, users.all);
    assert.deepEqual(JSON.parse(users.stdout), { preview_session_id: SESSION, users: [] });
    const mints = platform.state.requests.filter((r) => r.path.endsWith('/preview/tool-credential'));
    assert.equal(mints.length, 1); assert.equal(mints[0].auth, 'Bearer smt_tools'); assert.equal(mints[0].body.preview_session_id, SESSION);
    const stored = join(home, '.somewhere', 'previews', `${PROJECT}__${SESSION}.json`);
    assert.ok(existsSync(stored));
    assert.equal(statSync(stored).mode & 0o777, 0o600, 'owner-only');
    assert.equal(statSync(dirname(stored)).mode & 0o777, 0o700);
    assert.ok(!readdirSync(join(dir, '.somewhere')).some((name) => name.includes('credential')), 'nothing in the project folder');
    assert.ok(!users.all.includes(CREDENTIAL), 'never printed');

    const added = await run(['preview', 'user-add', 'tester@example.com', '--password', 'tester-password-1', '--json'], dir, env);
    assert.equal(added.status, 0, added.all);
    assert.equal(JSON.parse(added.stdout).user.email, 'tester@example.com');
    const mail = await run(['preview', 'mail', '--limit', '5'], dir, env);
    assert.equal(mail.status, 0, mail.all); assert.match(mail.stdout, /code: 123456/); assert.match(mail.stdout, /nothing was delivered/);
    const removed = await run(['preview', 'user-remove', 'u-1'], dir, env);
    assert.equal(removed.status, 0, removed.all);

    assert.equal(platform.state.requests.filter((r) => r.path.endsWith('/preview/tool-credential')).length, 1, 'minted once, then reused');
    assert.ok(toolRequests(platform.state).length >= 4);
    assert.ok(toolRequests(platform.state).every((r) => r.auth === 'Bearer ' + CREDENTIAL), 'every tool request carries only the preview credential');
  } finally { await platform.close(); }
});

test('a dead preview credential is forgotten and never replaced by the developer sign-in', async () => {
  const platform = await fakePlatform();
  const { home, dir } = folder();
  const env = platform.env(home);
  try {
    assert.equal((await run(['preview', 'users'], dir, env)).status, 0);
    platform.state.dead = true;
    const before = platform.state.requests.length;
    const refused = await run(['preview', 'users', '--json'], dir, env);
    assert.equal(refused.status, 1, refused.all);
    assert.match(refused.stdout + refused.stderr, /PREVIEW_CREDENTIAL_INVALID/);
    const after = platform.state.requests.slice(before);
    assert.ok(after.every((r) => !r.path.startsWith('/v1/preview-tools/') || r.auth === 'Bearer ' + CREDENTIAL), 'no tool request with the developer sign-in');
    assert.ok(!existsSync(join(home, '.somewhere', 'previews', `${PROJECT}__${SESSION}.json`)), 'the dead credential is forgotten');
  } finally { await platform.close(); }
});

test('preview tools need an open preview for the folder or a named one', async () => {
  const platform = await fakePlatform();
  const { home, dir } = folder({ withPreview: false });
  try {
    const r = await run(['preview', 'mail'], dir, platform.env(home));
    assert.equal(r.status, 1);
    assert.match(r.all, /no open preview/i);
    assert.equal(toolRequests(platform.state).length, 0);
    const named = await run(['preview', 'users', '--preview-session', SESSION, '--json'], dir, platform.env(home));
    assert.equal(named.status, 0, named.all);
  } finally { await platform.close(); }
});
