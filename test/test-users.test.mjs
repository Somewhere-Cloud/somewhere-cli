import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsks 668f0ce2 / b05cf814: `somewhere test-users` prepares preverified signed-in test users as
// standard Playwright storageState files, reads a fresh verification code, and cleans up only
// what this folder created. Offline against a stub of the existing platform APIs.
const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const DEV_KEY = 'smt_developer_secret_key';
const ORIGIN = 'https://tu-app.somewhere.site';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (iat, exp, sub) => `${b64({ alg: 'HS256' })}.${b64({ sub, iat, exp })}.sig_${sub}`;

const api = { calls: [], live: new Map(), failCreateAt: null, createCount: 0, messages: [], listFails: false };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  api.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
  res.setHeader('Content-Type', 'application/json');
  const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
  const p = url.pathname;
  if (req.method === 'GET' && p.endsWith('/projects/proj_tu/urls')) return send(200, { ok: true, data: { prod_fallback: ORIGIN } });
  if (req.method === 'GET' && /\/projects\/(proj_tu|tu-app)$/.test(p)) return send(200, { ok: true, data: { id: 'proj_tu', subdomain: 'tu-app' } });
  if (req.method === 'POST' && p.endsWith('/auth/test-users')) {
    api.createCount += 1;
    if (api.failCreateAt === api.createCount) return send(409, { ok: false, error: 'TEST_USERS_CAP_REACHED', message: 'This project already has 25 live test identities.' });
    const iat = 1_800_000_000 + api.createCount;
    const identities = Array.from({ length: body.count }, (_, i) => {
      const id = `u_${api.createCount}_${i}`;
      api.live.set(id, body.role);
      return { user: { id, email: `t-${body.label}-${id}@tu-app.test.somewhere.site`, role: body.role, email_verified: true, test: true, created_at: iat },
        access_token: jwt(iat, iat + 60, id), refresh_token: `rt_${id}_secret`, session_token: `st_${id}`, expires_in: 60, session_ttl_seconds: 3600 };
    });
    return send(201, { ok: true, data: { identities } });
  }
  if (req.method === 'GET' && p.endsWith('/auth/test-users')) {
    if (api.listFails) return send(503, { ok: false, error: 'UNAVAILABLE', message: 'later' });
    return send(200, { ok: true, data: { identities: [...api.live.keys()].map((id) => ({ id, test: true })) } });
  }
  if (req.method === 'DELETE' && p.endsWith('/auth/test-users')) {
    for (const id of body.ids ?? []) if (!api.keepOnDelete?.includes(id)) api.live.delete(id);
    return send(200, { ok: true, data: { deleted: (body.ids ?? []).length, ids: body.ids } });
  }
  if (req.method === 'GET' && p.endsWith('/email/test-inbox')) return send(200, { ok: true, data: { address: url.searchParams.get('address'), messages: api.messages } });
  send(404, { ok: false, error: 'NOT_FOUND', message: req.url });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function run(args, cwd, configDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distIndex, 'test-users', ...args], { cwd, env: { ...process.env, NO_COLOR: '1', SOMEWHERE_API_URL: apiUrl, SOMEWHERE_CONFIG_DIR: configDir } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (status) => resolve({ status, out }));
  });
}

function fixture({ linked = 'proj_tu' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sw-test-users-'));
  const configDir = join(root, 'config');
  const app = join(root, 'app');
  mkdirSync(configDir); mkdirSync(app);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ token: DEV_KEY, user: { email: 'd@e.f', username: 'd' } }));
  if (linked) writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: linked }));
  return { app, configDir };
}
const reset = () => { api.calls = []; api.live = new Map(); api.failCreateAt = null; api.createCount = 0; api.messages = []; api.listFails = false; api.keepOnDelete = undefined; };
const mode = (path) => statSync(path).mode & 0o777;
const allStateText = (app) => readdirSync(join(app, '.somewhere', 'test')).map((f) => readFileSync(join(app, '.somewhere', 'test', f), 'utf8')).join('\n');

test('prepare writes one private Playwright storageState per actor with the hosted-verify seed and server expiry', async () => {
  reset();
  const { app, configDir } = fixture();
  const r = await run(['prepare', 'alice', 'bob:admin'], app, configDir);
  assert.equal(r.status, 0, r.out);
  const dir = join(app, '.somewhere', 'test');
  assert.equal(mode(dir), 0o700);
  for (const f of ['alice.state.json', 'bob.state.json', 'manifest.json']) assert.equal(mode(join(dir, f)), 0o600, f);
  assert.match(readFileSync(join(app, '.gitignore'), 'utf8'), /^\.somewhere\/test\/$/m);

  const state = JSON.parse(readFileSync(join(dir, 'alice.state.json'), 'utf8'));
  const [access, refresh] = state.cookies;
  assert.deepEqual([access.name, refresh.name], ['__Host-token', '__Host-sw_refresh_token']);
  for (const c of state.cookies) assert.deepEqual([c.domain, c.path, c.httpOnly, c.secure, c.sameSite], ['tu-app.somewhere.site', '/', true, true, 'Lax']);
  assert.equal(access.expires, 1_800_000_001 + 3600, 'access cookie lives for the session, so an expired token is still presented for refresh');
  assert.equal(JSON.parse(Buffer.from(access.value.split('.')[1], 'base64url')).exp, 1_800_000_001 + 60, 'the access token keeps its own expiry');
  assert.equal(refresh.expires, 1_800_000_001 + 3600, 'refresh cookie expires with the server session (iat + session_ttl_seconds)');
  assert.equal(state.origins[0].origin, ORIGIN);
  const ls = Object.fromEntries(state.origins[0].localStorage.map((e) => [e.name, e.value]));
  assert.deepEqual(Object.keys(ls).sort(), ['sw_access_token', 'sw_auth', 'sw_auth_user']);
  const auth = JSON.parse(ls.sw_auth);
  assert.equal(auth.access_token, access.value);
  assert.equal(auth.token, access.value);
  assert.equal(auth.refresh_token, refresh.value);
  assert.equal(auth.expires_at, (1_800_000_001 + 60) * 1000);

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'prepared');
  assert.deepEqual(manifest.actors.map((a) => [a.name, a.role]), [['alice', 'user'], ['bob', 'admin']]);
  assert.match(manifest.retained_note, /App rows, files and stored test mail .* are kept/);
  assert.doesNotMatch(JSON.stringify(manifest), /eyJ|rt_|st_|access_token|refresh_token/, 'manifest holds no token');
  assert.doesNotMatch(r.out, /eyJ|rt_u_|st_u_|sig_u_/, 'stdout holds no token');
  assert.ok(!allStateText(app).includes(DEV_KEY), 'the developer key is never written to state');
  const creates = api.calls.filter((c) => c.method === 'POST');
  assert.deepEqual(creates.map((c) => [c.body.role, c.body.count, c.body.include_tokens]), [['user', 1, true], ['admin', 1, true]]);
});

test('prepare refuses an unlinked folder, another project, and any non-production origin, before creating anyone', async () => {
  reset();
  const unlinked = fixture({ linked: null });
  assert.equal((await run(['prepare', 'alice'], unlinked.app, unlinked.configDir)).status, 1);
  const other = fixture({ linked: 'proj_other' });
  const mismatch = await run(['prepare', 'alice', '--project', 'proj_tu'], other.app, other.configDir);
  assert.match(mismatch.out, /PROJECT_FOLDER_MISMATCH/);
  const { app, configDir } = fixture();
  const preview = await run(['prepare', 'alice', '--origin', 'https://tu-app-draft.somewhere.site'], app, configDir);
  assert.equal(preview.status, 1);
  assert.match(preview.out, /UNSUPPORTED_ORIGIN/);
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 0, 'no identity created');
  assert.ok(!existsSync(join(app, '.somewhere', 'test')), 'no state written');
});

test('a partly failed prepare records the identities that were created, and a second prepare waits for cleanup', async () => {
  reset();
  api.failCreateAt = 2;
  const { app, configDir } = fixture();
  const r = await run(['prepare', 'alice', 'bob:admin'], app, configDir);
  assert.equal(r.status, 1);
  assert.match(r.out, /TEST_USERS_CAP_REACHED/);
  const manifest = JSON.parse(readFileSync(join(app, '.somewhere', 'test', 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'partial');
  assert.deepEqual(manifest.actors.map((a) => a.name), ['alice']);
  const again = await run(['prepare', 'carol'], app, configDir);
  assert.match(again.out, /TEST_USERS_NOT_CLEANED/);
});

test('inbox returns only mail newer than the checkpoint, and reveals the magic link only on explicit request', async () => {
  reset();
  const { app, configDir } = fixture();
  const address = 'signup-abc@tu-app.test.somewhere.site';
  const checkpoint = Date.parse('2026-10-21T20:00:00Z');
  api.messages = [
    { id: 'old', to: address, subject: 'Old', verification_code: '111111', magic_link: 'https://tu-app.somewhere.site/v?t=OLDSECRET', created_at: '2026-10-21T19:59:00Z' },
    { id: 'other', to: 'someone@tu-app.test.somewhere.site', subject: 'Other', verification_code: '999999', magic_link: null, created_at: '2026-10-21T20:05:00Z' },
  ];
  const stale = await run(['inbox', address, '--since', String(checkpoint)], app, configDir);
  assert.equal(stale.status, 1);
  assert.match(stale.out, /TEST_INBOX_NO_NEW_MESSAGE/);
  assert.doesNotMatch(stale.out, /111111|999999/, 'a stale or foreign code is never returned');

  api.messages.push({ id: 'new', to: address, subject: 'Verify', verification_code: '424242', magic_link: 'https://tu-app.somewhere.site/v?t=NEWSECRET', created_at: '2026-10-21T20:01:00Z' });
  const text = await run(['inbox', address, '--since', String(checkpoint)], app, configDir);
  assert.equal(text.status, 0, text.out);
  assert.match(text.out, /verification_code: 424242/);
  assert.doesNotMatch(text.out, /NEWSECRET/);
  const json = JSON.parse((await run(['inbox', address, '--since', '2026-10-21T20:00:00Z', '--json'], app, configDir)).out);
  assert.equal(json.message.verification_code, '424242');
  assert.equal(json.message.magic_link_present, true);
  assert.equal(json.message.magic_link, undefined);
  const withLink = JSON.parse((await run(['inbox', address, '--since', String(checkpoint), '--json', '--include-link'], app, configDir)).out);
  assert.equal(withLink.message.magic_link, 'https://tu-app.somewhere.site/v?t=NEWSECRET');
  const file = await run(['inbox', address, '--since', String(checkpoint), '--link-out', 'verify-link.txt'], app, configDir);
  assert.doesNotMatch(file.out, /NEWSECRET/);
  assert.equal(mode(join(app, '.somewhere', 'test', 'verify-link.txt')), 0o600);
  assert.equal((await run(['inbox', address, '--since', String(checkpoint), '--link-out', '../escape.txt'], app, configDir)).status, 1);
  const wait = api.calls.filter((c) => c.path.endsWith('/email/test-inbox')).at(-1);
  assert.equal(wait.query.address, address);
});

test('address gives a fresh test-domain mailbox and checkpoint without creating anyone', async () => {
  reset();
  const { app, configDir } = fixture();
  const out = JSON.parse((await run(['address', '--name', 'invitee', '--json'], app, configDir)).out);
  assert.match(out.address, /^invitee-[0-9a-f]{12}@tu-app\.test\.somewhere\.site$/);
  assert.ok(Number.isInteger(out.checkpoint));
  assert.equal(api.calls.filter((c) => c.path.endsWith('/auth/test-users')).length, 0);
});

test('cleanup deletes only the recorded ids, reads back, reports each class separately and keeps app data', async () => {
  reset();
  const { app, configDir } = fixture();
  assert.equal((await run(['prepare', 'alice', 'bob'], app, configDir)).status, 0);
  api.live.set('someone_else', 'user'); // a test user this folder did not create
  const r = await run(['cleanup', '--json'], app, configDir);
  assert.equal(r.status, 0, r.out);
  const receipt = JSON.parse(r.out);
  const del = api.calls.find((c) => c.method === 'DELETE');
  assert.deepEqual(del.body, { project_id: 'proj_tu', ids: ['u_1_0', 'u_1_1'] }, 'only recorded ids, never all:true');
  assert.deepEqual(receipt.identities.removed, ['u_1_0', 'u_1_1']);
  assert.deepEqual([receipt.identities.remaining, receipt.identities.unknown], [[], []]);
  assert.match(receipt.app_data_files_and_test_mail, /^retained: .*kept/);
  assert.deepEqual(receipt.local_state.removed.sort(), ['alice.state.json', 'bob.state.json']);
  assert.ok(api.live.has('someone_else'), 'another identity is untouched');
  const dir = join(app, '.somewhere', 'test');
  assert.ok(!existsSync(join(dir, 'manifest.json')));
  assert.equal(mode(join(dir, 'cleanup-receipt.json')), 0o600);
});

test('cleanup that cannot confirm removal keeps the manifest and the state, and exits non-zero', async () => {
  reset();
  const { app, configDir } = fixture();
  assert.equal((await run(['prepare', 'alice', 'bob'], app, configDir)).status, 0);
  api.keepOnDelete = ['u_1_1'];
  const r = await run(['cleanup', '--json'], app, configDir);
  assert.equal(r.status, 1);
  const receipt = JSON.parse(r.out);
  assert.deepEqual([receipt.identities.removed, receipt.identities.remaining], [['u_1_0'], ['u_1_1']]);
  const manifest = JSON.parse(readFileSync(join(app, '.somewhere', 'test', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.actors.map((a) => a.user_id), ['u_1_1']);
  assert.ok(existsSync(join(app, '.somewhere', 'test', 'bob.state.json')), 'state kept for the identity still live');
  api.listFails = true;
  const unknown = JSON.parse((await run(['cleanup', '--json'], app, configDir)).out);
  assert.deepEqual(unknown.identities.unknown, ['u_1_1'], 'an unconfirmed readback is unknown, not removed');
});

test('a manifest whose state file points outside .somewhere/test is refused and nothing is deleted', async () => {
  reset();
  const { app, configDir } = fixture();
  assert.equal((await run(['prepare', 'alice'], app, configDir)).status, 0);
  const outside = join(app, 'precious.txt');
  writeFileSync(outside, 'keep me');
  const path = join(app, '.somewhere', 'test', 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.actors[0].state_file = '../../precious.txt';
  writeFileSync(path, JSON.stringify(manifest));
  const r = await run(['cleanup'], app, configDir);
  assert.equal(r.status, 1);
  assert.match(r.out, /MANIFEST_INVALID/);
  assert.equal(readFileSync(outside, 'utf8'), 'keep me', 'the file outside the state dir is untouched');
  assert.equal(api.calls.filter((c) => c.method === 'DELETE').length, 0, 'no identity deleted from a refused manifest');
  manifest.actors[0].state_file = 'alice.state.json';
  manifest.actors[0].name = '../alice';
  writeFileSync(path, JSON.stringify(manifest));
  assert.match((await run(['cleanup'], app, configDir)).out, /MANIFEST_INVALID/);
  assert.match((await run(['inbox', '../alice', '--since', '0'], app, configDir)).out, /MANIFEST_INVALID/);
});

