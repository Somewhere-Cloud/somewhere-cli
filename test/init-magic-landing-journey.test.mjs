// tsk_28753a0e, tsk_74d3bf0e: the plain `somewhere init` auth starter redeems a
// sign-in or group invitation link on /auth/magic. This drives the generated
// landing hook and the real pinned SDK client over a recording fetch. Opening
// or reloading the page sends nothing (a link preview or mail scanner cannot
// spend the token); the token leaves the address bar at once; only the Continue
// press sends it, once; an account already signed in here is signed out first
// (and a sign-out the server did not confirm sends nothing); only a same-origin
// redirect is followed; a failure or an unknown outcome is shown, never retried.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { pinStarterToLocalCli } from './local-cli-pack.mjs';

const source = Boolean(process.env.SOMEWHERE_TEST_SOURCE);
const moduleRoot = source ? '../src' : '../dist';
const ext = source ? 'ts' : 'js';
const { resolveInitSelection } = await import(`${moduleRoot}/lib/init-features.${ext}`);
const { createFeatureTemplate } = await import(`${moduleRoot}/lib/init-feature-template.${ext}`);
const { writeInitScaffold } = await import(`${moduleRoot}/lib/init-scaffold.${ext}`);
const { runTypecheck } = await import(`${moduleRoot}/lib/typecheck.${ext}`);
const ts = createRequire(import.meta.url)('typescript');

const ORIGIN = 'https://crew.somewhere.site';

/** The smallest hook host the landing needs: state, refs and effects with
 *  deps. `strict` replays the first effect pass the way React StrictMode does
 *  in development (run, clean up, run again with the same refs). */
function createHost() {
  const slots = [];
  let cursor = 0;
  let queued = [];
  let dirty = false;
  const host = {
    useState(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[at];
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next;
        dirty = true;
      }];
    },
    useRef(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { current: initial };
      return slots[at];
    },
    useEffect(effect, deps) {
      const at = cursor++;
      const previous = slots[at];
      if (!previous || !deps || deps.some((dep, i) => dep !== previous.deps[i])) {
        slots[at] = { deps, cleanup: previous?.cleanup ?? null };
        queued.push(at, effect);
      }
    },
  };
  function runEffects() {
    const pending = queued;
    queued = [];
    for (let i = 0; i < pending.length; i += 2) {
      const slot = slots[pending[i]];
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.cleanup = pending[i + 1]() ?? null;
    }
    return pending;
  }
  return {
    host,
    render(hook, { strict = false } = {}) {
      cursor = 0;
      const out = hook();
      const ran = runEffects();
      if (strict) {
        for (let i = 0; i < ran.length; i += 2) {
          const slot = slots[ran[i]];
          if (typeof slot.cleanup === 'function') slot.cleanup();
          slot.cleanup = ran[i + 1]() ?? null;
        }
      }
      return out;
    },
    takeDirty() {
      const was = dirty;
      dirty = false;
      return was;
    },
  };
}

function transpile(code) {
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

// The typecheck never installs (read-only, pfb_8f0f7cdd04a1); this test installs
// the starter's pinned dependencies itself, the way a developer runs npm install.
const installStarter = (specs, cwd) => {
  const done = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel', 'error', ...specs],
    { cwd, stdio: 'ignore', shell: process.platform === 'win32' });
  if (done.error) throw done.error;
  if (done.status !== 0) throw new Error(`npm install exited ${done.status}`);
};

/** The generated auth starter, its pinned SDK installed, and the landing hook
 *  and auth client compiled to modules that import the real SDK. */
async function prepareStarter(ui) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-magic-journey-'));
  writeInitScaffold(dir, createFeatureTemplate(resolveInitSelection('auth', ui), { appName: 'Crew' }));
  pinStarterToLocalCli(dir);
  if (process.env.SOMEWHERE_TEST_SDK_TARBALL) {
    const pkgPath = join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.dependencies['@somewhere-cloud/sdk'] = `file:${process.env.SOMEWHERE_TEST_SDK_TARBALL}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  }
  const checked = await runTypecheck(dir, { installTypePackages: installStarter });
  assert.equal(checked.ok, true, checked.raw);
  const sdkAuth = join(dir, 'node_modules', '@somewhere-cloud', 'sdk', 'dist', 'esm', 'auth', 'index.js');
  assert.ok(existsSync(sdkAuth), 'the starter installs its pinned SDK');
  const out = join(dir, '.journey');
  mkdirSync(out);
  writeFileSync(join(out, 'react.mjs'), [
    'export const useState = (v) => globalThis.__journeyHost.useState(v);',
    'export const useRef = (v) => globalThis.__journeyHost.useRef(v);',
    'export const useEffect = (f, d) => globalThis.__journeyHost.useEffect(f, d);',
  ].join('\n'));
  writeFileSync(join(out, 'sdk-react.mjs'), [
    'export const useAuth = () => globalThis.__journeyAuth;',
    'export const useAuthState = () => globalThis.__journeyAuth.getState();',
  ].join('\n'));
  const service = transpile(readFileSync(join(dir, 'src/services/auth.ts'), 'utf8'))
    .replace("'@somewhere-cloud/sdk/auth'", JSON.stringify(pathToFileURL(sdkAuth).href));
  writeFileSync(join(out, 'services-auth.mjs'), service);
  const mfa = transpile(readFileSync(join(dir, 'src/auth/useMfaContinuation.ts'), 'utf8'))
    .replace("from 'react'", "from './react.mjs'")
    .replace("from '@somewhere-cloud/sdk/react'", "from './sdk-react.mjs'")
    .replace("'@somewhere-cloud/sdk/auth'", JSON.stringify(pathToFileURL(sdkAuth).href))
    .replace("from '../services/auth'", "from './services-auth.mjs'");
  assert.doesNotMatch(mfa, /from '(react|@somewhere-cloud\/sdk\/react|@somewhere-cloud\/sdk\/auth|\.\.\/services\/auth)'/);
  writeFileSync(join(out, 'useMfaContinuation.mjs'), mfa);
  const landing = transpile(readFileSync(join(dir, 'src/auth/magic-link.ts'), 'utf8'))
    .replace("from 'react'", "from './react.mjs'")
    .replace("from '@somewhere-cloud/sdk/react'", "from './sdk-react.mjs'")
    .replace("from '../services/auth'", "from './services-auth.mjs'")
    .replace("from './useMfaContinuation'", "from './useMfaContinuation.mjs'");
  assert.doesNotMatch(landing, /from '(react|@somewhere-cloud\/sdk\/react|\.\.\/services\/auth|\.\/useMfaContinuation)'/);
  writeFileSync(join(out, 'magic-link.mjs'), landing);
  return { dir, out };
}

let starter;
async function starterModules() {
  starter ??= await prepareStarter('styled');
  return starter;
}

/** One tab on /auth/magic<search>. `respond` answers each fetch. load() is a
 *  page load (a fresh SDK client and hook, the same history entry, as a reload
 *  keeps it); press() is the Continue button. */
async function openTab(search, respond) {
  const { out } = await starterModules();
  const events = [];
  const fetches = [];
  const location = {
    origin: ORIGIN,
    pathname: '/auth/magic',
    search,
    get href() { return `${ORIGIN}${this.pathname}${this.search}`; },
    replace(target) { events.push(['navigate', target]); },
    assign(target) { events.push(['assign', target]); },
  };
  const history = {
    state: null,
    replaceState(state, _title, url) {
      events.push(['replaceState', url]);
      history.state = state === null ? null : structuredClone(state);
      const next = new URL(url, ORIGIN);
      location.pathname = next.pathname;
      location.search = next.search;
    },
  };
  let host;
  let hook;
  let landing;
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (host.takeDirty()) landing = host.render(hook);
    }
  };
  const within = async (work) => {
    const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
    globalThis.document = {};
    globalThis.window = { location, history, addEventListener() {} };
    globalThis.fetch = async (url, init = {}) => {
      const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, addressBar: location.href };
      fetches.push(call);
      events.push(['fetch', call.method, call.url]);
      return respond(call);
    };
    try { return await work(); } finally { Object.assign(globalThis, saved); }
  };
  const tab = {
    events,
    history,
    get landing() { return landing; },
    verifies: () => fetches.filter((call) => call.url.includes('/magic-link/verify')),
    fetches: () => fetches,
    load: () => within(async () => {
      // A fresh client per page load, as a full navigation would create.
      const nonce = `?load=${Math.random()}`;
      const { auth } = await import(pathToFileURL(join(out, 'services-auth.mjs')).href + nonce);
      const { useMagicLinkLanding } = await import(pathToFileURL(join(out, 'magic-link.mjs')).href + nonce);
      globalThis.__journeyAuth = auth;
      // The app's SomewhereAuthProvider checks the session as the page starts.
      void auth.getUser().catch(() => {});
      host = createHost();
      globalThis.__journeyHost = host.host;
      hook = useMagicLinkLanding;
      landing = host.render(hook, { strict: true });
      await settle();
      // The session check has answered: render what the person now sees.
      landing = host.render(hook);
      return tab;
    }),
    press: () => within(async () => {
      landing.confirm();
      await settle();
      return tab;
    }),
  };
  return tab;
}

const verified = () => new Response(JSON.stringify({ ok: true, cookie_session: true, user: { id: 'usr_invitee', email: 'invitee@example.com' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const signedOut = () => new Response(JSON.stringify({ error: 'AUTH_REQUIRED' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
const answer = (verify) => (call) => (call.url.includes('/magic-link/verify') ? verify(call) : signedOut());

const inviteSearch = (redirect) => `?${new URLSearchParams({ token: 'tok_once', redirect_uri: redirect })}`;

const me = (email) => () => new Response(JSON.stringify({ user: { id: 'usr_current', email } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** Route by path: verify, logout, everything else (the /me session check). */
const routes = ({ verify = verified, logout = () => json(200, { ok: true }), session = signedOut } = {}) => (call) => {
  if (call.url.includes('/magic-link/verify')) return verify(call);
  if (call.url.includes('/logout')) return logout(call);
  return session(call);
};
const TEAM = `${ORIGIN}/teams/7?invite_id=inv_1`;

test('opening or reloading the link sends nothing; the token leaves the address bar at once', async () => {
  const tab = await openTab(inviteSearch(TEAM), answer(verified));
  await tab.load();
  assert.equal(tab.verifies().length, 0, 'opening the page (StrictMode effects included) must not redeem');
  assert.equal(tab.landing.status, 'confirm');
  assert.equal(tab.landing.signedInAs, null);
  assert.deepEqual(tab.events.find(([kind]) => kind === 'replaceState'), ['replaceState', '/auth/magic']);
  assert.ok(tab.fetches().every((call) => call.addressBar === `${ORIGIN}/auth/magic`), 'no request ever ran with the token in the address bar');
  assert.ok(tab.fetches().every((call) => !JSON.stringify(call).includes('tok_once')), 'the token is in no request yet');
  // A reload of the same tab: the address bar is clean, the history entry
  // still holds the link, and loading again still sends nothing.
  await tab.load();
  assert.equal(tab.verifies().length, 0);
  assert.equal(tab.landing.status, 'confirm');
});

test('Continue sends the token once and opens its same-origin page', async () => {
  const tab = await openTab(inviteSearch(TEAM), answer(verified));
  await tab.load();
  const confirm = tab.landing.confirm;
  await tab.press();
  confirm(); // a second press (a double click) after the first was sent
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(tab.verifies().length, 1, 'the token is sent once');
  assert.deepEqual({ url: tab.verifies()[0].url, method: tab.verifies()[0].method, body: tab.verifies()[0].body },
    { url: '/api/auth/magic-link/verify', method: 'POST', body: { token: 'tok_once' } });
  assert.equal(tab.verifies()[0].addressBar, `${ORIGIN}/auth/magic`);
  assert.deepEqual(tab.events.filter(([kind]) => kind === 'navigate'), [['navigate', '/teams/7?invite_id=inv_1']]);
  assert.equal(tab.history.state, null, 'the spent token is forgotten');
});

test('another account signed in here is shown, and signed out before the link is sent', async () => {
  const tab = await openTab(inviteSearch(TEAM), routes({ session: me('alice@example.com') }));
  await tab.load();
  assert.equal(tab.landing.status, 'confirm');
  assert.equal(tab.landing.signedInAs, 'alice@example.com');
  assert.equal(tab.verifies().length, 0);
  await tab.press();
  const order = tab.events.filter(([kind, , url]) => kind === 'fetch' && /\/(logout|magic-link\/verify)$/.test(url)).map(([, , url]) => url);
  assert.deepEqual(order, ['/api/auth/logout', '/api/auth/magic-link/verify'], 'sign-out is answered before the token is sent');
  assert.deepEqual(tab.events.filter(([kind]) => kind === 'navigate'), [['navigate', '/teams/7?invite_id=inv_1']]);
});

test('a sign-out the server did not confirm sends nothing and keeps the link usable', async () => {
  let logoutWorks = false;
  const tab = await openTab(inviteSearch(TEAM), routes({
    session: me('alice@example.com'),
    logout: () => (logoutWorks ? json(200, { ok: true }) : json(500, { error: 'INTERNAL' })),
  }));
  await tab.load();
  await tab.press();
  assert.equal(tab.verifies().length, 0, 'the current account was not confirmed signed out, so the link was not sent');
  assert.equal(tab.landing.status, 'confirm');
  assert.equal(tab.landing.error, 'Could not sign out of the current account. Try again.');
  assert.equal(tab.history.state?.somewhereMagicLink?.token, 'tok_once', 'the unsent link is still held');
  logoutWorks = true;
  await tab.press();
  assert.equal(tab.verifies().length, 1);
  assert.deepEqual(tab.events.filter(([kind]) => kind === 'navigate'), [['navigate', '/teams/7?invite_id=inv_1']]);
});

test('a cross-origin redirect_uri is ignored and the invitee lands home', async () => {
  for (const hostile of ['https://evil.example/steal', '//evil.example/x', 'javascript:alert(1)']) {
    const tab = await openTab(inviteSearch(hostile), answer(verified));
    await tab.load();
    await tab.press();
    assert.equal(tab.verifies().length, 1, hostile);
    assert.deepEqual(tab.events.filter(([kind]) => kind === 'navigate'), [['navigate', '/']], hostile);
  }
});

test('a used or expired link shows the failure once and never retries or navigates', async () => {
  const tab = await openTab(inviteSearch(TEAM), answer(() => json(401,
    { ok: false, error: 'AUTH_INVALID_CREDS', message: 'Invalid, used, or expired sign-in link. Request a new one.' })));
  await tab.load();
  await tab.press();
  assert.equal(tab.verifies().length, 1);
  assert.deepEqual(tab.landing, { status: 'failed', error: 'Invalid, used, or expired sign-in link. Request a new one.' });
  assert.deepEqual(tab.events.filter(([kind]) => kind === 'navigate'), []);
  assert.equal(tab.history.state, null);
  await tab.load(); // a reload does not bring the spent token back
  assert.deepEqual(tab.landing, { status: 'failed', error: 'This sign-in link is incomplete. Request a new one.' });
  assert.equal(tab.verifies().length, 1);
});

test('an unknown outcome (the request never answered) is shown, not replayed', async () => {
  const tab = await openTab(inviteSearch(`${ORIGIN}/`), answer(() => { throw new TypeError('fetch failed'); }));
  await tab.load();
  await tab.press();
  assert.equal(tab.verifies().length, 1, 'no automatic second attempt with a one-time token');
  assert.deepEqual(tab.landing, { status: 'failed', error: 'Could not reach the server. Check your connection and try again.' });
  assert.deepEqual(tab.events.filter(([kind]) => kind === 'navigate'), []);
});

test('a verified account with a second factor continues to the emailed code step', async () => {
  const tab = await openTab(inviteSearch(TEAM), answer(() => json(200,
    { ok: true, mfa_required: true, mfa_token: 'mfa_ticket', redirect_uri: TEAM, invite_id: 'inv_1' })));
  await tab.load();
  await tab.press();
  assert.equal(tab.verifies().length, 1);
  assert.equal(tab.landing.status, 'mfa');
  assert.deepEqual(tab.events.filter(([kind]) => kind === 'navigate'), [], 'no page opens before the code');
});

test('a link without a token fails without calling the platform', async () => {
  const tab = await openTab('?redirect_uri=%2F', answer(verified));
  await tab.load();
  assert.equal(tab.verifies().length, 0);
  assert.deepEqual(tab.landing, { status: 'failed', error: 'This sign-in link is incomplete. Request a new one.' });
});
