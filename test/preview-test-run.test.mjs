// `somewhere test --preview` and `openAppTest({ preview: true })` (design slice 3a; Astra slice-3
// check A4/A6, FIX DURING BUILD runner rows), end to end: the real CLI, the real Playwright runner and
// Chrome, the real fixtures and form helpers, against a fake platform that records every request and
// a fake preview app whose gate admits only the run's pinned session for the current candidate, as
// the web gate does. Every request that is not a preview-tool call with the preview credential is a
// production call and fails the test.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFiles } from '../dist/lib/base-files.js';
import { collectFiles } from '../dist/lib/files.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const PROJECT = '00000000-0000-4000-8000-0000000000e5';
const DRAFT = 'draft_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CANDIDATE = 'rel_candidate_E001';
const CREDENTIAL = `swpt.${PROJECT}.${DRAFT}.${'s'.repeat(10)}${randomUUID().replaceAll('-', '')}`;
const COOKIE = 'sw_draft_cap'; // the platform names it; on an http test origin it cannot be __Host-

// ── Shared state: the preview's store, mail and sessions; every secret seen ─────────────────────
const state = { candidate: CANDIDATE, dead: false, requests: [], production: [], users: new Map(), sessions: new Map(), mail: [], notes: new Map(), teams: new Map(), secrets: new Set([CREDENTIAL]) };
// Someone in the preview who is not one of a run's sign-ups (a person the app's own users invited).
state.users.set('pvu_outsider', { id: 'pvu_outsider', email: 'outsider@e5.test', password: 'x', test: false, verified: true });
/** The platform's rule (DESIGN.md slice 3a follow-ups, part B): delete the listed accounts together, with the
 *  teams whose every member is listed; the only owner of a team with a member outside the list is kept. */
function deleteTogether(ids, { option, kindOf }) {
  const results = new Map(); const ok = [];
  for (const id of new Set(ids)) { const kind = kindOf(id); if (kind === 'ok') ok.push(id); else results.set(id, kind); }
  const listed = new Set(ok); const groupsDeleted = [];
  if (option) for (const [id, team] of [...state.teams]) {
    if ([...team.members.keys()].every((m) => listed.has(m)) && [...team.members].some(([m, r]) => r === 'owner' && listed.has(m))) { state.teams.delete(id); groupsDeleted.push({ id, name: team.name }); }
  }
  const stranded = [...state.teams].filter(([, team]) => [...team.members].some(([m, r]) => r === 'owner' && listed.has(m))
    && ![...team.members].some(([m, r]) => r === 'owner' && !listed.has(m)));
  for (const id of ok) {
    const own = stranded.filter(([, team]) => team.members.get(id) === 'owner');
    if (own.length) { results.set(id, { id, outcome: 'kept', groups: own.map(([gid, team]) => ({ id: gid, name: team.name })) }); continue; }
    for (const team of state.teams.values()) team.members.delete(id);
    state.users.delete(id); results.set(id, { id, outcome: 'deleted' });
  }
  return { results: [...new Set(ids)].map((id) => results.get(id)), groups_deleted: groupsDeleted };
}
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => resolve(raw)); });
let appOrigin = '';

const platform = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://platform');
  const raw = await readBody(req);
  const auth = req.headers.authorization ?? '';
  state.requests.push(`${req.method} ${url.pathname}`);
  // Production routes answer only in the production-runner test, and only to the developer key.
  if (state.productionAllowed && auth === 'Bearer smt_production_developer_key' && !url.pathname.startsWith('/v1/preview-tools/')) {
    if (req.method === 'GET' && url.pathname === `/v1/projects/${PROJECT}/urls`) return json(res, 200, { ok: true, data: { prod_fallback: appOrigin, active_release_id: 'rel_live_1' } });
    if (req.method === 'GET' && url.pathname === '/v1/db/access-map') return json(res, 200, { ok: true, data: { release: { id: 'rel_live_1' }, browser_data: { contract_digest: 'digest-live' } } });
    if (req.method === 'GET' && url.pathname === '/v1/email/test-inbox') {
      const address = url.searchParams.get('address');
      return json(res, 200, { ok: true, data: { messages: [...state.mail].reverse().filter((m) => m.to === address) } });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/users/delete') {
      const body = JSON.parse(raw);
      state.requests.push(`POST /v1/auth/users/delete ${JSON.stringify(body)}`);
      return json(res, 200, { ok: true, data: deleteTogether(body.ids, { option: body.delete_groups_only_they_belong_to === true, kindOf: (id) => state.users.has(id) ? 'ok' : { id, outcome: 'not_found' } }) });
    }
    return json(res, 404, { ok: false, error: 'NOT_FOUND', message: url.pathname });
  }
  if (!url.pathname.startsWith('/v1/preview-tools/') || auth !== `Bearer ${CREDENTIAL}`) {
    state.production.push(`${req.method} ${url.pathname} ${auth.slice(0, 12)}`);
    return json(res, 500, { ok: false, error: 'PRODUCTION_CALL', message: 'a preview run made a non-preview call' });
  }
  if (state.dead) return json(res, 401, { ok: false, error: 'PREVIEW_CREDENTIAL_INVALID', message: 'This preview credential is not valid.' });
  const path = url.pathname.slice('/v1/preview-tools'.length);
  const body = raw ? JSON.parse(raw) : {};
  if (req.method === 'GET' && path === '/target') return json(res, 200, { ok: true, data: { project_id: PROJECT, preview_session_id: DRAFT, preview_id: state.candidate, origin: appOrigin, contract_digest: 'digest-e' } });
  if (req.method === 'POST' && path === '/browser-session') {
    const id = randomUUID();
    state.sessions.set(id, { candidate: state.candidate, ended: false });
    const value = `${DRAFT}.${state.candidate}.${id}`;
    state.secrets.add(value); state.secrets.add(id);
    return json(res, 201, { ok: true, data: { preview_session_id: DRAFT, preview_id: state.candidate, session_id: id, origin: appOrigin, expires_at: Date.now() + 7200_000, cookie: { name: COOKIE, value } } });
  }
  if (req.method === 'DELETE' && path.startsWith('/browser-session/')) {
    const s = state.sessions.get(decodeURIComponent(path.split('/')[2]));
    if (s) s.ended = true;
    return json(res, 200, { ok: true, data: { ended: Boolean(s) } });
  }
  if (req.method === 'POST' && path === '/users') {
    const id = 'pvu_' + randomUUID(), email = `preview-${id.slice(4, 12)}@e5.test.somewhere.site`, password = 'Pv-managed-' + randomUUID();
    state.users.set(id, { id, email, password, test: true, verified: true }); state.secrets.add(password);
    return json(res, 201, { ok: true, data: { preview_session_id: DRAFT, user: { id, email, email_verified: true }, password } });
  }
  if (req.method === 'DELETE' && path.startsWith('/users/')) {
    const id = decodeURIComponent(path.split('/')[2]); const u = state.users.get(id);
    if (!u) return json(res, 404, { ok: false, error: 'USER_NOT_FOUND', message: 'no' });
    if (!u.test) return json(res, 409, { ok: false, error: 'NOT_A_TEST_USER', message: 'no' });
    state.users.delete(id); return json(res, 200, { ok: true, data: { deleted: true } });
  }
  if (req.method === 'POST' && path === '/signups/delete') {
    return json(res, 200, { ok: true, data: { preview_session_id: DRAFT, ...deleteTogether(body.ids, { option: body.delete_groups_only_they_belong_to === true, kindOf: (id) => {
      const u = state.users.get(id);
      if (!id.startsWith('pvu_')) return { id, outcome: 'refused', code: 'VALIDATION_ERROR', message: 'exact id' };
      if (!u) return { id, outcome: 'not_found' };
      return u.test ? { id, outcome: 'refused', code: 'NOT_A_SIGNUP', message: 'managed test user' } : 'ok';
    } }) } });
  }
  if (req.method === 'DELETE' && path.startsWith('/signups/')) {
    const id = decodeURIComponent(path.split('/')[2]); const u = state.users.get(id);
    if (!id.startsWith('pvu_')) return json(res, 400, { ok: false, error: 'VALIDATION_ERROR', message: 'exact id' });
    if (!u) return json(res, 404, { ok: false, error: 'USER_NOT_FOUND', message: 'no' });
    if (u.test) return json(res, 409, { ok: false, error: 'NOT_A_SIGNUP', message: 'no' });
    state.users.delete(id); return json(res, 200, { ok: true, data: { deleted: true } });
  }
  if (req.method === 'GET' && path === '/mail') return json(res, 200, { ok: true, data: { preview_session_id: DRAFT, messages: [...state.mail].reverse() } });
  return json(res, 404, { ok: false, error: 'NOT_FOUND', message: path });
});

// ── The preview app: the gate, a starter-shaped form and a few routes ───────────────────────────
const PAGE = `<!doctype html><html><body><div id="root" data-app-state="loading">
<form id="f"><input type="email" data-sw-auth="email"><input type="password" data-sw-auth="password">
<button type="button" data-sw-auth="sign-up">Create account</button><button type="button" data-sw-auth="sign-in">Sign in</button></form>
<button type="button" data-sw-auth="sign-out" hidden>Sign out</button><p id="who"></p></div>
<script>
const root = document.getElementById('root'), form = document.getElementById('f'), out = document.querySelector('[data-sw-auth="sign-out"]');
function set(user) { root.dataset.appState = user ? 'signed-in' : 'signed-out'; form.hidden = !!user; out.hidden = !user; document.getElementById('who').textContent = user ? user.email : ''; }
async function auth(path) {
  const r = await fetch('/api/auth/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: form.querySelector('[type=email]').value, password: form.querySelector('[type=password]').value }) });
  const b = await r.json(); if (r.ok) set(b.user);
}
document.querySelector('[data-sw-auth="sign-up"]').onclick = () => auth('signup');
document.querySelector('[data-sw-auth="sign-in"]').onclick = () => auth('login');
out.onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); set(null); };
fetch('/api/auth/me').then((r) => r.json()).then((b) => set(b.user));
</script></body></html>`;
const CUSTOM = `<!doctype html><html><body><form id="cf"><input id="cf-email" type="email"><input id="cf-pass" type="password">
<button type="button" id="cf-up">Join</button><button type="button" id="cf-in">Log in</button></form>
<script>
document.getElementById('cf-up').onclick = async () => {
  const r = await fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: document.getElementById('cf-email').value, password: document.getElementById('cf-pass').value }) });
  if (!r.ok) return;
  const w = await (await fetch('/api/custom/welcome', { method: 'POST' })).json();
  document.getElementById('cf').remove();
  document.body.insertAdjacentHTML('beforeend', '<div id="banner"></div>');
  document.getElementById('banner').textContent = w.text;
};
</script></body></html>`;
const appSessions = new Map();
const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
function mail(to, code) { state.mail.push({ id: 'm' + state.mail.length, to, subject: '[Preview] Your verification code', verification_code: code, magic_link: null, created_at: new Date().toISOString(), environment: 'preview', preview_session_id: DRAFT }); state.secrets.add(code); }
const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://app');
  const raw = await readBody(req);
  const c = cookies(req);
  // The gate: only a live session pinned to the current candidate (validatePreviewCapabilitySession).
  const [, candidate, sessionId] = (c[COOKIE] ?? '').split('.');
  const session = state.sessions.get(sessionId);
  if (!state.productionAllowed && (!session || session.ended || state.dead || session.candidate !== state.candidate || candidate !== state.candidate)) { res.writeHead(404); return res.end('Preview not found'); }
  const user = appSessions.get(c.app_session) ?? null;
  // As the platform does: a cookie-authenticated POST must carry the app's own Origin.
  if (req.method === 'POST' && c.app_session && url.pathname.startsWith('/api/auth/') && req.headers.origin !== appOrigin) return json(res, 400, { error: 'ORIGIN_REQUIRED' });
  const body = raw ? JSON.parse(raw) : {};
  const signedIn = (u) => { const token = randomUUID(); appSessions.set(token, u.id); state.secrets.add(token); return { 'set-cookie': `app_session=${token}; Path=/; HttpOnly` }; };
  const me = user ? state.users.get(user) : null;
  switch (`${req.method} ${url.pathname}`) {
    case 'GET /': res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE);
    case 'GET /plain': res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p id="plain">A page with nothing secret on it.</p>');
    // A custom form (no starter hooks) whose confirmation shows the new account's code and password.
    case 'GET /custom': res.writeHead(200, { 'content-type': 'text/html' }); return res.end(CUSTOM);
    case 'POST /api/custom/welcome': {
      if (!me) return json(res, 401, { error: 'AUTH_REQUIRED' });
      const code = [...state.mail].reverse().find((m) => m.to === me.email)?.verification_code;
      return json(res, 200, { text: 'Welcome! Your verification code is ' + code + ' and your password is ' + me.password });
    }
    case 'GET /api/auth/me': return json(res, 200, { user: me ? { id: me.id, email: me.email } : null });
    case 'POST /api/auth/signup': {
      if ([...state.users.values()].some((u) => u.email === body.email)) return json(res, 409, { error: 'AUTH_EMAIL_EXISTS' });
      const u = { id: 'pvu_' + randomUUID(), email: body.email, password: body.password, test: false, verified: false };
      state.users.set(u.id, u); state.secrets.add(body.password); mail(u.email, String(randomInt(100000, 999999)));
      return json(res, 200, { user: { id: u.id, email: u.email } }, signedIn(u));
    }
    case 'POST /api/auth/login': {
      const u = [...state.users.values()].find((x) => x.email === body.email && x.password === body.password);
      return u ? json(res, 200, { user: { id: u.id, email: u.email } }, signedIn(u)) : json(res, 401, { error: 'AUTH_INVALID_CREDS' });
    }
    case 'POST /api/auth/logout': appSessions.delete(c.app_session); return json(res, 200, { ok: true }, { 'set-cookie': 'app_session=; Path=/; Max-Age=0' });
    case 'POST /api/auth/request-email-verification': if (!me) return json(res, 401, { error: 'AUTH_REQUIRED' }); mail(me.email, String(randomInt(100000, 999999))); return json(res, 200, { captured: true });
    case 'POST /api/auth/verify-email': {
      if (!me) return json(res, 401, { error: 'AUTH_REQUIRED' });
      const ok = state.mail.some((m) => m.to === me.email && m.verification_code === body.code);
      if (ok) me.verified = true;
      return ok ? json(res, 200, { verified: true }) : json(res, 400, { error: 'AUTH_CODE_INVALID' });
    }
    case 'GET /api/auth/verify-email': return json(res, me ? 200 : 401, { email_verified: Boolean(me?.verified) });
    case 'GET /api/verified-only': return me?.verified ? json(res, 200, { ok: true }) : json(res, 403, { error: 'EMAIL_NOT_VERIFIED' });
    case 'POST /api/notes': { if (!me) return json(res, 401, { error: 'AUTH_REQUIRED' }); const id = randomUUID(); state.notes.set(id, { owner: me.id, text: body.text }); return json(res, 200, { id }); }
    case 'POST /api/teams': { if (!me) return json(res, 401, { error: 'AUTH_REQUIRED' }); const id = 'grp_' + randomUUID().slice(0, 8); state.teams.set(id, { name: body.name, members: new Map([[me.id, 'owner']]) }); return json(res, 201, { team_id: id }); }
    case 'POST /api/teams/add': { const team = state.teams.get(body.team); if (!me || team?.members.get(me.id) !== 'owner') return json(res, 403, { error: 'OWNER_ONLY' }); team.members.set(body.user, 'member'); return json(res, 200, { added: true }); }
    case 'POST /__test/save': state.candidate = 'rel_candidate_E002'; return json(res, 200, { saved: true });
    case 'POST /__test/close': state.dead = true; return json(res, 200, { closed: true });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/notes/')) {
    const note = state.notes.get(url.pathname.split('/')[3]);
    if (!me) return json(res, 401, { error: 'AUTH_REQUIRED' });
    return note && note.owner === me.id ? json(res, 200, { text: note.text }) : json(res, 403, { error: 'FORBIDDEN' });
  }
  return json(res, 404, { error: 'NOT_FOUND' });
});

// ── The linked project folder ───────────────────────────────────────────────────────────────────
const SPEC = `import { test, expect, expectRefused } from '@somewhere-cloud/cli/testing';
test('sign up, unverified refusal, verify with captured mail, sign out and in, and another person is refused', async ({ page, signUp, verify, signOut, signIn, newPage }) => {
  const ana = await signUp(page);
  await expectRefused(page, 'GET /api/verified-only');
  await verify(page, ana);
  expect((await page.request.get('/api/verified-only')).status()).toBe(200);
  const { id } = await (await page.request.post('/api/notes', { data: { text: 'ana only' } })).json();
  await signOut(page);
  await signIn(page, ana);
  const benPage = await newPage();
  await signUp(benPage);
  await expectRefused(benPage, 'GET /api/notes/' + id, undefined, { allowed: page });
});
test('a managed preview test user is signed in', async ({ newUser, anonymous }) => {
  const user = await newUser();
  expect(user.id.startsWith('pvu_')).toBe(true);
  expect((await (await user.request.fetch('/api/auth/me')).json()).user.email).toBe(user.email);
  expect((await (await anonymous.fetch('/api/auth/me')).json()).user).toBe(null);
});
test('newUser({ role }) is refused in a preview, never granted another way', async ({ newUser }) => {
  await expect(newUser({ role: 'staff' })).rejects.toThrow(/not available in a preview/);
});
`;
const FAILS = `import { test, expect } from '@somewhere-cloud/cli/testing';
test('fails while a password is on the page', async ({ page, signUp }) => {
  const ana = await signUp(page);
  await page.evaluate((p) => document.body.insertAdjacentHTML('beforeend', '<div role="alert" id="leak">Your password is ' + p + '</div>'), ana.password);
  // The assertion error quotes the page text, so the raw error itself carries the password.
  await expect(page.locator('#leak')).toHaveText('nothing secret', { timeout: 500 });
});
test('fails on a custom form that shows the code and password', async ({ page, signUp }) => {
  await signUp(page, { form: { path: '/custom', email: '#cf-email', password: '#cf-pass', signUp: '#cf-up', signIn: '#cf-in', signedIn: '#banner' } });
  await expect(page.locator('#banner')).toHaveText('nothing secret', { timeout: 500 });
});
test('fails inside custom sign-up steps while the page shows the code', async ({ page, signUp }) => {
  await signUp(page, { form: { path: '/custom', signedIn: '#banner' }, steps: async (p, { email, password }) => {
    await p.fill('#cf-email', email); await p.fill('#cf-pass', password); await p.click('#cf-up');
    // Fails because the banner also shows the code and the password, quoting them in the error.
    await expect(p.locator('#banner')).toHaveText('Welcome', { timeout: 2000 });
  } });
});
test('fails on a page with nothing secret', async ({ page, signUp }) => {
  await signUp(page);
  await page.goto('/plain');
  expect('a plain page').toBe('photographed');
});
`;
const SAVE = `import { test, expect } from '@somewhere-cloud/cli/testing';
test('the preview is saved again mid-run', async ({ page }) => {
  await page.goto('/');
  await page.request.post('/__test/save');
  const again = await page.goto('/');
  expect(again.status()).toBe(200);
});
`;
// Every request the test makes passes; the preview is saved after the last one, so no request can notice
// (a web tier may admit an old session for up to ten seconds). Only the end-of-run check can.
const SAVE_UNNOTICED = `import { test, expect } from '@somewhere-cloud/cli/testing';
test('every request passes; the preview is saved after the last one', async ({ page }) => {
  expect((await page.goto('/')).status()).toBe(200);
  expect((await page.request.post('/__test/save')).status()).toBe(200);
});
`;
const SCRIPT_SAVE_UNNOTICED = `import { chromium } from '@playwright/test';
import { openAppTest } from '@somewhere-cloud/cli/script';
const app = await openAppTest({ preview: true });
const browser = await chromium.launch(app.launchOptions({ channel: 'chrome' }));
try {
  const page = await browser.newPage({ baseURL: app.origin });
  await app.prepare(page);
  await app.check('the page loads', async () => { if ((await page.goto('/')).status() !== 200) throw new Error('not 200'); });
  await page.request.post('/__test/save');
} finally { await browser.close(); await app.finish(); }
`;
// Part B: a team only this test's two sign-ups belong to, and a team one sign-up shares with someone else.
const TEAMS = `import { test, expect } from '@somewhere-cloud/cli/testing';
test('a team only this test\\'s sign-ups belong to', async ({ page, signUp, newPage }) => {
  await signUp(page);
  const benPage = await newPage();
  const ben = await signUp(benPage);
  const { team_id } = await (await page.request.post('/api/teams', { data: { name: 'Proof team' } })).json();
  expect((await page.request.post('/api/teams/add', { data: { team: team_id, user: ben.id } })).status()).toBe(200);
});
`;
const SHARED = `import { test, expect } from '@somewhere-cloud/cli/testing';
test('a team shared with someone outside the run', async ({ page, signUp }) => {
  await signUp(page);
  const { team_id } = await (await page.request.post('/api/teams', { data: { name: 'Shared' } })).json();
  expect((await page.request.post('/api/teams/add', { data: { team: team_id, user: 'pvu_outsider' } })).status()).toBe(200);
});
`;
const CLOSE = `import { test, expect } from '@somewhere-cloud/cli/testing';
test('the preview is closed mid-run', async ({ page, signUp }) => {
  await signUp(page);
  await page.request.post('/__test/close');
  const again = await page.goto('/');
  expect(again.status()).toBe(200);
});
`;
const SCRIPT = `import { chromium } from '@playwright/test';
import { openAppTest } from '@somewhere-cloud/cli/script';
const app = await openAppTest({ preview: true });
const browser = await chromium.launch(app.launchOptions({ channel: 'chrome' }));
try {
  const anaPage = await browser.newPage({ baseURL: app.origin });
  const ana = await app.signUp(anaPage);
  await app.check('unverified is refused', async () => { if ((await anaPage.request.get(app.origin + '/api/verified-only')).status() !== 403) throw new Error('not refused'); });
  await app.verify(anaPage, ana);
  await app.check('verified', async () => { if ((await anaPage.request.get(app.origin + '/api/verified-only')).status() !== 200) throw new Error('not verified'); });
  await app.signOut(anaPage);
  await app.signIn(anaPage, ana);
  await app.check('signed back in', async () => { if (!(await (await anaPage.request.get(app.origin + '/api/auth/me')).json()).user) throw new Error('signed out'); });
} finally { await browser.close(); await app.finish(); }
`;

const PROD_RECORD = { project_id: PROJECT, email: 'sw-prod@example.com', id: 'prod-user-1', run: 'old-production-run', pid: 999999998, created_at: '2026-11-14T00:00:00.000Z' };
let root, configDir, prodRecordPath;
function makeProject() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'sw-preview-test-run-'));
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: PROJECT, name: 'e5', subdomain: 'e5' }));
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  writeFileSync(join(dir, '.somewhere', 'preview.json'), JSON.stringify({ project_id: PROJECT, preview_session_id: DRAFT, preview_id: CANDIDATE, files: {}, saved_at: new Date().toISOString() }));
  // A retained production cleanup record from an earlier production run (its runner is gone).
  const prodDir = join(dir, '.somewhere', 'tests', 'accounts', PROJECT);
  mkdirSync(prodDir, { recursive: true });
  prodRecordPath = join(prodDir, '1700000000000-0badf00d.json');
  writeFileSync(prodRecordPath, JSON.stringify(PROD_RECORD) + '\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'e5', private: true, type: 'module' }));
  mkdirSync(join(dir, 'node_modules', '@somewhere-cloud'), { recursive: true });
  symlinkSync(join(repoRoot, 'node_modules', '@playwright'), join(dir, 'node_modules', '@playwright'));
  symlinkSync(join(repoRoot, 'node_modules', 'playwright'), join(dir, 'node_modules', 'playwright'));
  symlinkSync(join(repoRoot, 'node_modules', 'playwright-core'), join(dir, 'node_modules', 'playwright-core'));
  symlinkSync(repoRoot, join(dir, 'node_modules', '@somewhere-cloud', 'cli'));
  mkdirSync(join(dir, 'tests'));
  for (const [name, content] of [['preview.spec.ts', SPEC], ['fails.spec.ts', FAILS], ['save.spec.ts', SAVE], ['save-unnoticed.spec.ts', SAVE_UNNOTICED], ['close.spec.ts', CLOSE], ['teams.spec.ts', TEAMS], ['shared.spec.ts', SHARED], ['check.mjs', SCRIPT], ['save-unnoticed.mjs', SCRIPT_SAVE_UNNOTICED]]) writeFileSync(join(dir, 'tests', name), content);
  // What `somewhere preview` records after a save: the folder's published files exactly as sent.
  writeFileSync(join(dir, '.somewhere', 'preview.json'), JSON.stringify({ project_id: PROJECT, preview_session_id: DRAFT, preview_id: CANDIDATE, files: hashFiles(dir, collectFiles(dir).published), saved_at: new Date().toISOString() }));
  return dir;
}
function makeConfig({ credential = true } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'sw-preview-test-config-'));
  // A developer sign-in is present: a preview run must not use it (any use is a production call above).
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ token: 'smt_production_developer_key', api_key: 'smt_production_developer_key' }), { mode: 0o600 });
  if (credential) {
    mkdirSync(join(dir, 'previews'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'previews', `${PROJECT}__${DRAFT}.json`), JSON.stringify({ credential: CREDENTIAL, project_id: PROJECT, preview_session_id: DRAFT, minted_at: new Date().toISOString() }), { mode: 0o600 });
  }
  return dir;
}
function run(args, cwd, config, { detached = false, onChild } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, detached, env: { ...process.env, SOMEWHERE_API_URL: `http://127.0.0.1:${platform.address().port}/v1`, SOMEWHERE_CONFIG_DIR: config,
      CI: '1', NO_COLOR: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', SOMEWHERE_NO_UPDATE_CHECK: '1', SOMEWHERE_NO_BROWSER: '1', SW_TEST_TARGET: '', SW_TEST_RUN: '' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c)); child.stderr.on('data', (c) => (stderr += c));
    onChild?.(child);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr, all: stdout + stderr }));
  });
}
const somewhere = (args, cwd = root, config = configDir, options) => run([distIndex, ...args], cwd, config, options);
/** Every artifact as it exists the moment it is written or changed (before any later step reads,
 *  uploads or deletes it), from a recursive watch on the folder's .somewhere directory. */
function watchArtifacts(dir, onFile) {
  const seen = [];
  const watcher = watch(dir, { recursive: true }, (_event, name) => {
    if (!name) return;
    const path = join(dir, name);
    try { if (statSync(path).isFile()) { const text = readFileSync(path).toString('latin1'); seen.push({ name, text }); onFile?.(name, text); } } catch { /* removed already */ }
  });
  return { seen, close: () => watcher.close() };
}
const leakedIn = (texts) => [...state.secrets].filter((secret) => texts.some((text) => text.includes(secret))).map((secret) => `${secret.slice(0, 4)}…(${secret.length})`);
function files(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, out); else out.push(path);
  }
  return out;
}
/** Every seeded secret value the platform and app handed out, searched in every artifact and in the output. */
function leaked(output) {
  const texts = [output, ...files(root).map((path) => readFileSync(path).toString('latin1'))];
  return [...state.secrets].filter((secret) => texts.some((text) => text.includes(secret))).map((secret) => `${secret.slice(0, 4)}…(${secret.length})`);
}
const reset = () => { state.requests.length = 0; state.production.length = 0; };

before(async () => {
  await new Promise((resolve) => platform.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  appOrigin = `http://127.0.0.1:${app.address().port}`;
  root = makeProject();
  configDir = makeConfig();
});
after(() => { platform.close(); app.close(); });

test('somewhere test --preview runs the journey on the preview with its own credential only, cleans up by exact id and leaks nothing', { timeout: 300_000 }, async () => {
  reset();
  const prodBefore = { text: readFileSync(prodRecordPath, 'utf8'), mtime: statSync(prodRecordPath).mtimeMs };
  const r = await somewhere(['test', '--preview', 'tests/preview.spec.ts', '--workers', '2']);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /SUBSET \(only the tests selected for this run\): 3 passed, 0 failed/);
  assert.match(r.stdout, new RegExp(`preview ${DRAFT} · ${appOrigin.replaceAll('.', '\\.')} · ${CANDIDATE}`));
  assert.deepEqual(state.production, [], 'no production call of any kind');
  assert.ok(state.requests.every((line) => line.includes('/v1/preview-tools/')));
  assert.ok(state.requests.includes('GET /v1/preview-tools/target') && state.requests.includes('POST /v1/preview-tools/users') && state.requests.some((l) => l.startsWith('DELETE /v1/preview-tools/signups/pvu_')));
  assert.deepEqual([...state.users.values()].map((u) => u.email), [], 'every account the run made is gone: form sign-ups by exact id, managed users through the preview tool');
  assert.ok([...state.sessions.values()].every((s) => s.ended), 'every pinned browser session was ended');
  assert.equal(readFileSync(prodRecordPath, 'utf8'), prodBefore.text, 'the production cleanup record is untouched');
  assert.equal(statSync(prodRecordPath).mtimeMs, prodBefore.mtime);
  assert.ok(!state.requests.some((l) => l.includes('prod-user-1')));
  const previewJournal = join(root, '.somewhere', 'tests', 'preview-accounts', PROJECT, DRAFT);
  assert.deepEqual(existsSync(previewJournal) ? readdirSync(previewJournal) : [], [], 'the preview journal is finished');
  const results = JSON.parse(readFileSync(join(root, '.somewhere', 'tests', 'results.json'), 'utf8'));
  assert.equal(results.environment, 'preview'); assert.equal(results.preview_session_id, DRAFT); assert.equal(results.release, CANDIDATE); assert.equal(results.releaseConfirmed, true);
  assert.ok(!JSON.parse(readFileSync(join(root, '.somewhere', 'tests', 'runner.config.cjs'), 'utf8').replace(/^module\.exports = /, '').replace(/;\s*$/, '')).toString().includes(CREDENTIAL));
  assert.deepEqual(leaked(r.all), [], 'no password, code, cookie, session or credential in any artifact or output');
});

test('at the moment of failure: no artifact, report or output holds a secret, for the starter form and a custom form; a plain page is still photographed', { timeout: 300_000 }, async () => {
  reset();
  const watched = watchArtifacts(join(root, '.somewhere'));
  const r = await somewhere(['test', '--preview', 'tests/fails.spec.ts', '--workers', '1']);
  watched.close();
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /4 failed/);
  assert.match(r.stdout, /toHaveText[\s\S]*Expected/, 'the failure still says which assertion failed and what it expected');
  assert.match(r.stdout, /signUp: fill and submit the sign-up form failed/, 'and in which helper step');
  const contexts = watched.seen.filter((f) => f.name.endsWith('error-context.md'));
  assert.ok(contexts.length >= 4, 'Playwright wrote its error context for each failure (seen at write time)');
  assert.ok(contexts.every((f) => !f.text.includes('# Page snapshot')), 'no page snapshot is ever written');
  assert.ok(contexts.some((f) => f.text.includes('[redacted]')), 'the quoted page text was scrubbed before the write');
  const pngs = files(join(root, '.somewhere', 'tests')).filter((path) => path.endsWith('.png'));
  assert.equal(pngs.length, 1, 'only the plain page is photographed');
  assert.match(r.stdout, /screenshot: not captured/);
  assert.deepEqual(state.production, []);
  assert.deepEqual(leakedIn(watched.seen.map((f) => f.text)), [], 'no secret in any artifact at the moment it was written');
  assert.deepEqual(leaked(r.all), [], 'nor in output or anything left after the run');
  assert.deepEqual([...state.users.values()].filter((u) => !u.test).map((u) => u.email), [], 'every sign-up, including the one whose custom step failed, was removed by exact id');
});

test('a run interrupted right after a failure, before any cleanup, leaves no secret on disk', { timeout: 300_000 }, async () => {
  reset();
  let killed = false;
  let child;
  const watched = watchArtifacts(join(root, '.somewhere'), (name) => {
    if (!killed && name.endsWith('error-context.md') && child) { killed = true; setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 300); }
  });
  const r = await somewhere(['test', '--preview', 'tests/fails.spec.ts', '--workers', '1'], root, configDir, { detached: true, onChild: (c) => { child = c; } });
  watched.close();
  assert.ok(killed, 'the run was interrupted after Playwright wrote a failure report');
  assert.notEqual(r.status, 0);
  const left = files(join(root, '.somewhere', 'tests'));
  assert.ok(left.some((path) => path.endsWith('error-context.md')), 'the failure report is still on disk: cleanup never ran');
  assert.deepEqual(leakedIn([...watched.seen.map((f) => f.text), ...left.map((path) => readFileSync(path).toString('latin1'))]), [], 'no secret in what an interrupted run leaves');
  assert.deepEqual(state.production, []);
});

test('a preview saved again mid-run fails the run as a preview run, never passing for another version or touching production', { timeout: 300_000 }, async () => {
  reset(); state.candidate = CANDIDATE;
  const r = await somewhere(['test', '--preview', 'tests/save.spec.ts', '--workers', '1']);
  state.candidate = CANDIDATE;
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /saved again during this run \(rel_candidate_E001 → rel_candidate_E002\)/);
  assert.doesNotMatch(r.stdout, /0 failed, 0 expected failures, 0 setup errors/);
  assert.deepEqual(state.production, []);
  assert.deepEqual(leaked(r.all), []);
});

test('the end-of-run check fails a run whose every request passed when the preview was saved after the last one', { timeout: 300_000 }, async () => {
  reset(); state.candidate = CANDIDATE;
  const r = await somewhere(['test', '--preview', 'tests/save-unnoticed.spec.ts', '--workers', '1']);
  state.candidate = CANDIDATE;
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /passed: every request passes; the preview is saved after the last one/, 'the test itself passed');
  assert.match(r.all, /saved again during this run \(rel_candidate_E001 → rel_candidate_E002\)/);
  const report = JSON.parse(readFileSync(join(root, '.somewhere', 'tests', 'results.json'), 'utf8'));
  assert.equal(report.releaseConfirmed, false);
  assert.equal(report.release, 'release changed during run');
  assert.deepEqual(state.production, []);
});

test('the script helper\'s finish() fails a script whose every check passed when the preview was saved after the last one', { timeout: 300_000 }, async () => {
  reset(); state.candidate = CANDIDATE;
  const r = await run(['tests/save-unnoticed.mjs'], root, configDir);
  state.candidate = CANDIDATE;
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /the preview was saved again during the script \(rel_candidate_E001 → rel_candidate_E002\)/);
  const results = JSON.parse(readFileSync(join(root, '.somewhere', 'app-check-preview.json'), 'utf8'));
  assert.deepEqual(results.checks.map((c) => [c.name, c.ok]), [['the page loads', true], ['the preview stayed on the same saved version during the script', false]]);
  assert.deepEqual(state.production, []);
});

test('a preview closed mid-run fails the run as a preview run; cleanup is reported, never sent to production', { timeout: 300_000 }, async () => {
  reset(); state.dead = false;
  const r = await somewhere(['test', '--preview', 'tests/close.spec.ts', '--workers', '1']);
  state.dead = false;
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /preview is closed, promoted or expired/);
  assert.match(r.all, /nothing ran against production/);
  assert.match(r.all, /Dropped the cleanup record of sw-[0-9a-f]+@example\.com: the preview is closed, promoted or expired, and its accounts went with it/);
  assert.doesNotMatch(r.all, /the next (somewhere test|run) retries/, 'a record that can never succeed is not retried for ever');
  assert.deepEqual(files(join(root, '.somewhere', 'tests', 'preview-accounts')).filter((f) => f.endsWith('.json')), [], 'the closed preview\'s records are gone');
  // Part C: no "same preview version" to rerun on.
  assert.doesNotMatch(r.all, /on the same preview version/);
  assert.match(r.all, /The preview changed or closed during this run\. Save it again with `somewhere preview` \(or open a new one if it closed\), then run all the tests again: somewhere test --preview/);
  assert.deepEqual(state.production, [], 'no production delete, sweep or lookup as recovery');
  assert.ok(existsSync(prodRecordPath));
  assert.deepEqual(leaked(r.all), []);
});

test('cleanup deletes the sign-ups of a test together with a team only they belong to (one call, preview tool only)', { timeout: 300_000 }, async () => {
  reset();
  const usersBefore = new Set(state.users.keys());
  const r = await somewhere(['test', '--preview', 'tests/teams.spec.ts', '--workers', '1']);
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /Deleted 1 team\(s\) that only this test's sign-ups belonged to: "Proof team" \(grp_[0-9a-f]+\)/);
  assert.equal([...state.teams.values()].filter((t) => t.name === 'Proof team').length, 0);
  assert.deepEqual([...state.users.keys()].filter((id) => !usersBefore.has(id)), [], 'both sign-ups deleted');
  assert.equal(state.requests.filter((l) => l === 'POST /v1/preview-tools/signups/delete').length, 1, 'one call for the test\'s two accounts');
  assert.deepEqual(state.production, []);
});

test('a team with a member outside the run is left alone: its owner is kept, the team named, the record kept', { timeout: 300_000 }, async () => {
  reset();
  const r = await somewhere(['test', '--preview', 'tests/shared.spec.ts', '--workers', '1']);
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /it is the only owner of the team "Shared" \(grp_[0-9a-f]+\), which has members outside this run's sign-ups; the team and the account were left alone/);
  const [teamId, team] = [...state.teams].find(([, t]) => t.name === 'Shared');
  assert.ok(team.members.has('pvu_outsider') && state.users.has('pvu_outsider'), 'the outsider and the team stay');
  const kept = files(join(root, '.somewhere', 'tests', 'preview-accounts')).filter((f) => f.endsWith('.json'));
  assert.equal(kept.length, 1, 'the record is kept for a later run');
  // Hand the team over as the app would, then the next run finishes the record.
  const owner = [...team.members].find(([, role]) => role === 'owner')[0];
  team.members.set('pvu_outsider', 'owner'); team.members.delete(owner);
  const again = await somewhere(['test', '--preview', 'tests/teams.spec.ts', '--workers', '1']);
  assert.equal(again.status, 0, again.all);
  assert.match(again.all, /Before this run: deleted 1 leftover form sign-up account\(s\) by their recorded ids/);
  assert.ok(state.teams.has(teamId), 'the shared team stays with its new owner');
  assert.deepEqual(state.production, []);
});

test('no open preview, or no credential for it on this machine: refused before any request, never minting with your sign-in', async () => {
  reset();
  const noPreview = makeProject();
  writeFileSync(join(noPreview, '.somewhere', 'preview.json'), '{}');
  const r1 = await somewhere(['test', '--preview'], noPreview);
  assert.equal(r1.status, 1); assert.match(r1.all, /This folder has no open preview\. Open one with `somewhere preview`/);
  const r2 = await somewhere(['test', '--preview'], root, makeConfig({ credential: false }));
  assert.equal(r2.status, 1); assert.match(r2.all, /This machine holds no credential for preview draft_e+/);
  state.dead = true;
  const r3 = await somewhere(['test', '--preview'], root);
  state.dead = false;
  assert.equal(r3.status, 1); assert.match(r3.all, /preview is closed, promoted or expired/);
  assert.deepEqual(state.production, [], 'never the developer sign-in, never a tool-credential mint');
  assert.ok(!state.requests.some((l) => l.includes('tool-credential')));
});

test('the script helper takes the same preview option: the same journey, its own credential only, exact cleanup', { timeout: 300_000 }, async () => {
  reset();
  const before = new Set(state.sessions.keys());
  const usersBefore = new Set(state.users.keys());
  const r = await run(['tests/check.mjs'], root, configDir);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, new RegExp(`PASSED: 3 passed, 0 failed · preview ${DRAFT} · `));
  assert.deepEqual(state.production, []);
  assert.deepEqual([...state.users.values()].filter((u) => !u.test && !usersBefore.has(u.id)), [], 'its sign-up was removed by exact id');
  const mine = [...state.sessions].filter(([id]) => !before.has(id));
  assert.equal(mine.length, 1, 'one pinned session for the script');
  assert.ok(mine.every(([, s]) => s.ended), 'and finish() ended it');
  const results = JSON.parse(readFileSync(join(root, '.somewhere', 'app-check-preview.json'), 'utf8'));
  assert.equal(results.environment, 'preview'); assert.equal(results.release, CANDIDATE);
  assert.ok(existsSync(prodRecordPath), 'the production cleanup record is untouched');
  assert.deepEqual(leaked(r.all), []);
});

// The production runner had the same raw-artifact hole (Playwright's error-context.md, written before
// the runner's cleanup); the same fix covers it. Last in this file: a production run legitimately
// finishes the retained production cleanup record.
test('the production runner: at the moment of failure no artifact, report or output holds a secret, for the starter form and a custom form', { timeout: 300_000 }, async () => {
  reset(); state.productionAllowed = true;
  const watched = watchArtifacts(join(root, '.somewhere'));
  const r = await somewhere(['test', 'tests/fails.spec.ts', '--workers', '1']);
  watched.close(); state.productionAllowed = false;
  assert.equal(r.status, 1, r.all);
  assert.match(r.stdout, /4 failed/);
  assert.ok(state.requests.some((l) => l === `GET /v1/projects/${PROJECT}/urls`), 'it ran as a production run');
  const contexts = watched.seen.filter((f) => f.name.endsWith('error-context.md'));
  assert.ok(contexts.length >= 4 && contexts.every((f) => !f.text.includes('# Page snapshot')));
  assert.deepEqual(leakedIn(watched.seen.map((f) => f.text)), [], 'no secret in any artifact at the moment it was written');
  assert.deepEqual(leaked(r.all), []);
});
