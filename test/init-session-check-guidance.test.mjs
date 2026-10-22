import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createFeatureTemplate } from '../dist/lib/init-feature-template.js';
import { resolveInitSelection } from '../dist/lib/init-features.js';

// tsk_da2dba3d (rank 2 of TRANSCRIPT-RANKING, Haiku invites run): after a failed
// session check the starter always said "The server didn't answer. Check your
// connection", even when the server answered 5xx, and never said the sign-in
// state is unknown rather than failed, so an agent assumed its single-use link
// was spent and requested five new invitations. The panel now names what broke
// from the SDK's typed status only, says to retry before repeating a sign-in or
// link, and gives a status-only code to report. No server text is rendered.
const files = (ui) => createFeatureTemplate(resolveInitSelection('auth', ui), { appName: 'X' });
const read = (list, path) => { const entry = list.find((f) => f.path === path); assert(entry, path); return entry.content; };
const CANARY = 'smt_CANARYsecret0000 canary@example.invalid eyJhbGciOiJIUzI1NiJ9.e30.sig';

async function loadModule(source, prelude, names, jsx) {
  const emitted = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: jsx ? ts.JsxEmit.React : undefined, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } })
    .outputText.replace(/^import [\s\S]*?;$/gm, '');
  const path = join(mkdtempSync(join(tmpdir(), 'sw-session-check-')), 'm.mjs');
  writeFileSync(path, prelude + '\n' + emitted);
  return import(path);
}

async function hookFor(states) {
  let i = 0; const refs = [];
  globalThis.__sessionFixture = {
    useSdkAuthState: () => ({ ...states[Math.min(i, states.length - 1)], recheck: async () => null }),
    useAuth: () => ({}), useRef: (v) => { const r = refs[0] ?? { current: v }; refs[0] = r; return r; },
    useState: (v) => [v, () => {}], authErrorMessage: (e) => e.message, PASSWORD_MIN_LENGTH: 8, useMfaContinuation: () => ({}),
  };
  const mod = await loadModule(read(files('styled'), 'src/auth/hooks.ts'),
    'const { useSdkAuthState, useAuth, useRef, useState, authErrorMessage, PASSWORD_MIN_LENGTH, useMfaContinuation } = globalThis.__sessionFixture;', []);
  return { next: () => { const s = mod.useAuthState(); i++; return s; } };
}
const failed = (status) => ({ status: 'indeterminate', user: null, error: { code: 'SESSION_CHECK_FAILED', status, message: 'The session check failed ' + CANARY } });

test('the hook carries only the typed check status: HTTP status, or 0 for no response; never the message', async () => {
  for (const [input, want] of [[503, 503], [500, 500], [403, 403], [0, 0], [999, 0], ['503', 0], [undefined, 0]]) {
    const { next } = await hookFor([failed(input)]);
    const s = next();
    assert.equal(s.status, 'unavailable');
    assert.equal(s.checkStatus, want, String(input));
    assert.ok(!JSON.stringify(s).includes('canary'), 'no server message in state');
  }
  const other = await hookFor([{ status: 'indeterminate', user: null, error: { code: 'SOMETHING_ELSE', status: 503, message: CANARY } }]);
  assert.equal(other.next().checkStatus, 0, 'only SESSION_CHECK_FAILED supplies a status');
  // A re-check that fails for the account confirmed on this page is 'suspended' and carries it too.
  const user = { id: 'u1', email: 'u@example.invalid' };
  const kept = await hookFor([{ status: 'authenticated', user, error: null }, { ...failed(502), user }]);
  assert.equal(kept.next().status, 'signed-in');
  const s = kept.next();
  assert.equal(s.status, 'suspended'); assert.equal(s.checkStatus, 502);
  // LEGIT: a definitive answer (401 → signed-out) is unchanged.
  assert.equal((await hookFor([{ status: 'signed-out', user: null, error: null }])).next().status, 'signed-out');
});

const textOf = (node) => node == null || node === false ? '' : typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(textOf).join('') : textOf(node.c);

for (const ui of ['styled', 'headless']) {
  test(`${ui} panel: what broke from status only, retry before repeating a sign-in or link, a status-only report code`, async () => {
    const mod = await loadModule(read(files(ui), 'src/ui/feedback.tsx'),
      'const h = (t, p, ...c) => (typeof t === "function" ? t({ ...(p || {}), children: c }) : { t, p, c }); const Fragment = "f"; const useState = (v) => [v, () => {}]; const useEffect = () => {};', [], true);
    const render = (checkStatus, keepsWork = false) => textOf(mod.SessionUnavailable({ keepsWork, checkStatus, retrying: false, onRetry() {} }));
    const t503 = render(503);
    assert.match(t503, /server had a problem checking your sign-in \(HTTP 503\)/);
    assert.match(t503, /may still be valid: try again before signing in again or asking for a new link/);
    assert.match(t503, /report: SESSION_CHECK_FAILED, HTTP 503/);
    assert.doesNotMatch(t503, /didn't answer|couldn't reach/i, 'a 5xx is an answer, not a connection problem');
    const t0 = render(0);
    assert.match(t0, /couldn't reach the server/);
    assert.match(t0, /SESSION_CHECK_FAILED, no response/);
    assert.match(render(403), /refused the sign-in check \(HTTP 403\)/);
    // Review 3606: a 429 says to wait (not "refused" beside Try again); an unreadable 2xx is not a refusal.
    const t429 = render(429);
    assert.match(t429, /Too many sign-in checks just now \(HTTP 429\)\. Wait a minute/);
    assert.doesNotMatch(t429, /refused/);
    const t200 = render(200);
    assert.match(t200, /answer to the sign-in check couldn't be read \(HTTP 200\)/);
    assert.doesNotMatch(t200, /refused/);
    assert.match(render(503, true), /Your unsaved changes are kept/);
  });
}
