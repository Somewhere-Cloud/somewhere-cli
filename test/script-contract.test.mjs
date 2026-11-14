// Deterministic contract tests for the plain-script helpers (@somewhere-cloud/cli/script) and the
// shared form lifecycle: a real Chromium against routed fake apps, no network, no project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { signUp, signIn, signOut, FIND_MS } from '../dist/lib/form-auth.js';
import { classifyData, captureResponses, dataReady, launchOptions, undeployedChanges } from '../dist/lib/app-test.js';

const ORIGIN = 'https://app.test';
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', ...launchOptions() }); });
after(async () => { await browser?.close(); });

// A tiny app: the session state on the root (data-app-state), a form whose markup each case
// supplies, and an auth route that answers like the platform's.
function app(form, { appState = true } = {}) {
  return `<!doctype html><html><body><div id="root" ${appState ? 'data-app-state="signed-out"' : ''}>${form}<p id="who"></p></div>
<script>
const root = document.getElementById('root');
let mode = 'sign-in';
function wire() {
  for (const b of document.querySelectorAll('[data-action]')) b.onclick = async (e) => {
    e.preventDefault();
    const action = b.dataset.action === 'current' ? mode : b.dataset.action;
    const email = document.querySelector('input[type=email]').value, password = document.querySelector('input[type=password]').value;
    const r = await fetch('/api/auth/' + (action === 'sign-up' ? 'signup' : 'login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const body = await r.json();
    if (r.ok) { document.getElementById('who').textContent = body.user.email; if (root.hasAttribute('data-app-state')) root.setAttribute('data-app-state', 'signed-in'); document.querySelector('form')?.remove(); document.getElementById('root').insertAdjacentHTML('beforeend', '<button data-sw-auth="sign-out" id="out">Sign out</button>'); document.getElementById('out').onclick = () => { root.setAttribute('data-app-state', 'signed-out'); }; }
  };
  const toggle = document.querySelector('[data-toggle]');
  if (toggle) toggle.onclick = (e) => { e.preventDefault(); mode = mode === 'sign-in' ? 'sign-up' : 'sign-in'; const f = document.querySelector('form'); f.dataset.swAuthMode = mode; const s = document.querySelector('[data-action="current"]'); if (s.dataset.swAuth !== undefined && s.dataset.swAuth !== 'submit') s.dataset.swAuth = mode; s.textContent = mode; };
}
wire();
</script></body></html>`;
}
const FORMS = {
  // This release's starter: one submit naming its current action, and a mode switch.
  starter: `<form data-sw-auth-mode="sign-in"><input type="email" data-sw-auth="email"><input type="password" data-sw-auth="password">
    <button data-action="current" data-sw-auth="sign-in">sign-in</button><button data-toggle data-sw-auth="mode">switch</button></form>`,
  // Both actions visible at once, marked with the semantic hooks.
  twoButtons: `<form><input type="email" data-sw-auth="email"><input type="password" data-sw-auth="password">
    <button data-action="sign-in" data-sw-auth="sign-in">Sign in</button><button data-action="sign-up" data-sw-auth="sign-up">Create account</button></form>`,
  // A rewritten form with the brief's testids and no hooks at all (needs an adapter).
  testids: `<form><input type="email" data-testid="auth-email"><input type="password" data-testid="auth-password">
    <button data-action="sign-in" data-testid="auth-signin">Sign in</button><button data-action="sign-up" data-testid="auth-signup">Sign up</button></form>`,
  // Earlier starters (0.38.81–0.38.87): one submit, the mode on the form element.
  legacy: `<form data-sw-auth="form" data-sw-auth-mode="sign-in"><input type="email" data-sw-auth="email"><input type="password" data-sw-auth="password">
    <button data-action="current" data-sw-auth="submit">submit</button><button data-toggle data-sw-auth="mode">switch</button></form>`,
};
const ADAPTER = { email: '[data-testid=auth-email]', password: '[data-testid=auth-password]', signUp: '[data-testid=auth-signup]', signIn: '[data-testid=auth-signin]' };

function host() {
  const root = mkdtempSync(join(process.env.TMPDIR, 'script-contract-'));
  const client = { call: async (method, path) => { if (path === '/email/test-inbox') return { messages: [] }; throw new Error('unexpected control-plane call ' + method + ' ' + path); } };
  return { pages: new Set(), attempts: [], root, control: async () => ({ client, projectId: 'p-1', target: { projectId: 'p-1', origin: ORIGIN, host: 'app.test', releaseId: 'rel_1', contractDigest: 'digest-1' } }), attach: async () => {}, allowTime: () => {}, timed: (_n, w) => w() };
}
async function pageFor(html) {
  const context = await browser.newContext({ baseURL: ORIGIN });
  const page = await context.newPage();
  const ids = new Map();
  await page.route(ORIGIN + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/auth/')) {
      const { email } = JSON.parse(route.request().postData() ?? '{}');
      if (!ids.has(email)) ids.set(email, 'u-' + (ids.size + 1));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: ids.get(email), email } }) });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  return page;
}

for (const [layout, form] of Object.entries(FORMS)) {
  test(`signUp and signIn work on the ${layout} form`, async () => {
    const page = await pageFor(app(form));
    const run = host();
    const person = await signUp(run, page, layout === 'testids' ? { form: ADAPTER } : {});
    assert.match(person.email, /@example\.com$/);
    assert.equal(person.id, 'u-1');
    assert.equal(await page.locator('#who').textContent(), person.email);
    assert.equal(run.attempts[0].id, 'u-1', 'the account is recorded for exact-id cleanup');
    await signOut(run, page, {});
    await signIn(run, page, person, layout === 'testids' ? { form: ADAPTER } : {});
    await page.context().close();
  });
}

test('a form no adapter fits fails within seconds and says what to add', async () => {
  const page = await pageFor(app(FORMS.testids));
  const started = Date.now();
  await assert.rejects(signUp(host(), page, {}), (error) => {
    assert.match(error.message, /no email field \(\[data-sw-auth="email"\]\)/);
    assert.match(error.message, /data-sw-auth="email", "password", "sign-up" and "sign-in"/);
    assert.match(error.message, /\{ form: \{ email, password, signUp, signIn \} \}/);
    return true;
  });
  const took = Date.now() - started;
  assert.ok(took < FIND_MS + 3_000, `failed after ${took} ms, not ~${FIND_MS} ms`);
  await page.context().close();
});

test('custom steps run on the opened app, not a blank page', async () => {
  const page = await pageFor(app(FORMS.testids));
  let url = '';
  await signUp(host(), page, { steps: async (p, { email, password }) => {
    url = p.url();
    await p.fill('[data-testid=auth-email]', email); await p.fill('[data-testid=auth-password]', password); await p.click('[data-testid=auth-signup]');
  } });
  assert.equal(url, ORIGIN + '/');
  await page.context().close();
});

test('an app without data-app-state is not waited on; signedIn names what to wait for', async () => {
  const page = await pageFor(app(FORMS.testids, { appState: false }));
  const person = await signUp(host(), page, { form: { ...ADAPTER, signedIn: '#who:not(:empty)' } });
  assert.equal(await page.locator('#who').textContent(), person.email);
  await page.context().close();
});

test('data answers are classified; a malformed request is never an access refusal', () => {
  assert.equal(classifyData(200, { data: [{ id: 1 }] }).kind, 'ok');
  assert.equal(classifyData(200, { data: [] }).kind, 'empty');
  assert.equal(classifyData(200, { data: null }).kind, 'empty');
  assert.equal(classifyData(403, { error: 'POLICY_AUTHORITY_REQUIRED' }).kind, 'refused');
  assert.equal(classifyData(401, { error: 'AUTH_REQUIRED' }).kind, 'refused');
  assert.equal(classifyData(404, { error: 'DATA_NOT_FOUND' }).kind, 'missing-or-refused');
  assert.equal(classifyData(400, { error: 'DATA_INPUT_INVALID', message: 'unsupported field nope' }).kind, 'malformed');
  assert.equal(classifyData(409, { error: 'DATA_CONTRACT_MISMATCH' }).kind, 'stale-contract');
  assert.equal(classifyData(409, { error: 'DATA_CONFLICT' }).kind, 'error', 'a unique-key conflict is not a stale contract');
  assert.equal(classifyData(403, { error: 'DATA_ORIGIN_FORBIDDEN' }).kind, 'malformed', 'a wrong Origin is not an access refusal');
  assert.equal(classifyData(415, { error: 'DATA_JSON_REQUIRED' }).kind, 'malformed');
  assert.equal(classifyData(404, { error: 'NOT_FOUND' }).kind, 'error', 'an unknown route is not a refusal');
});

test('captureResponses waits for every body and says where a planted secret appeared', async () => {
  const context = await browser.newContext({ baseURL: ORIGIN });
  const page = await context.newPage();
  await page.route(ORIGIN + '/**', (route) => new URL(route.request().url()).pathname === '/api/notes'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notes: [{ title: 'private 42' }] }) })
    : route.fulfill({ status: 200, contentType: 'text/html', body: '<div data-sw-data="loading" id="l"></div><script>fetch("/api/notes").then(r => r.json()).then(() => { document.getElementById("l").dataset.swData = "ready"; })</script>' }));
  const seen = captureResponses(page);
  await page.goto('/');
  assert.equal(await dataReady(page), 'ready');
  const found = await seen.find('private 42');
  assert.equal(found.length, 1);
  assert.equal(found[0].url, ORIGIN + '/api/notes');
  assert.match(found[0].contentType, /json/);
  assert.deepEqual(await seen.find('not there'), []);
  await context.close();
});

test('the stale-release guard names files the live release does not have', () => {
  const root = mkdtempSync(join(process.env.TMPDIR, 'undeployed-'));
  mkdirSync(join(root, 'db'));
  writeFileSync(join(root, 'db/schema.ts'), 'export default 1;\n');
  writeFileSync(join(root, 'index.html'), '<html></html>\n');
  mkdirSync(join(root, '.somewhere'));
  writeFileSync(join(root, '.somewhere/base-files.json'), JSON.stringify({ project_id: 'p-1', release_id: 'rel_1', files: {} }));
  const before = undeployedChanges(root, 'p-1');
  assert.deepEqual(before.changed.sort(), ['db/schema.ts', 'index.html']);
  assert.equal(undeployedChanges(root, 'other-project'), null, 'another project\'s record proves nothing');
});

test('launchOptions keeps caller options and adds the system-resolver switch once', () => {
  assert.deepEqual(launchOptions({ headless: false, args: ['--x'] }), { headless: false, args: ['--disable-features=AsyncDns', '--x'] });
});
