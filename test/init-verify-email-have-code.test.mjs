import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createFeatureTemplate } from '../dist/lib/init-feature-template.js';
import { resolveInitSelection } from '../dist/lib/init-features.js';

// tsk_70d6db11: the code field only appeared after "Email me a code", so someone
// arriving with a code already emailed had to send again, which replaces that
// code. "I already have a code" opens the same form and sends nothing. The
// verification calls, the send's own errors (429 included) and the API stay as
// they were.
const files = (ui) => createFeatureTemplate(resolveInitSelection('auth', ui), { appName: 'X' });
const read = (list, path) => { const entry = list.find((f) => f.path === path); assert(entry, path); return entry.content; };

async function loadHook(auth) {
  const state = [];
  let cursor = 0;
  globalThis.__verifyFixture = {
    useAuth: () => auth,
    useState(initial) { const slot = cursor++; if (!(slot in state)) state[slot] = initial; return [state[slot], (value) => { state[slot] = typeof value === 'function' ? value(state[slot]) : value; }]; },
    useEffect(effect) { effect(); },
    authErrorMessage: (reason) => reason.message,
  };
  const emitted = ts.transpileModule(read(files('styled'), 'src/auth/useEmailVerification.ts'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/^import .*;$/gm, '');
  const path = join(mkdtempSync(join(tmpdir(), 'sw-verify-hook-')), 'hook.mjs');
  writeFileSync(path, 'const { useState, useEffect, useAuth, authErrorMessage } = globalThis.__verifyFixture;\n' + emitted);
  const { useEmailVerification } = await import(path);
  const settle = () => new Promise((r) => setImmediate(r));
  const render = () => { cursor = 0; return useEmailVerification(); };
  render();
  await settle();
  return { render, settle };
}

function stubAuth({ sendError } = {}) {
  const calls = [];
  return {
    calls,
    async emailVerified() { return false; },
    async requestEmailVerification() { calls.push('send'); if (sendError) throw sendError; },
    async verifyEmail(input) { calls.push(['verify', input.code]); if (input.code !== '246810') throw new Error('Incorrect or expired code.'); },
  };
}

test('"I already have a code" opens the code form and sends nothing; the existing code verifies', async () => {
  const auth = stubAuth();
  try {
    const { render, settle } = await loadHook(auth);
    let v = render();
    assert.equal(v.status, 'unverified');
    assert.equal(v.entering, false, 'the form starts closed, as before');
    v.enterCode();
    v = render();
    assert.equal(v.entering, true);
    assert.equal(v.sent, false, 'nothing was emailed in this visit');
    assert.deepEqual(auth.calls, [], 'opening the form never requests a code');
    v.setCode(' 246810 ');
    v = render();
    assert.equal(v.canSubmit, true);
    await v.submit();
    await settle();
    v = render();
    assert.equal(v.status, 'verified');
    assert.deepEqual(auth.calls, [['verify', '246810']], 'only the verification call, with the trimmed code');
  } finally { delete globalThis.__verifyFixture; }
});

test('a wrong code from an earlier email still fails and keeps the form open with the error', async () => {
  const auth = stubAuth();
  try {
    const { render, settle } = await loadHook(auth);
    render().enterCode();
    let v = render();
    v.setCode('111111');
    v = render();
    await v.submit();
    await settle();
    v = render();
    assert.equal(v.status, 'unverified');
    assert.equal(v.entering, true);
    assert.equal(v.error, 'Incorrect or expired code.');
    assert.deepEqual(auth.calls, [['verify', '111111']]);
  } finally { delete globalThis.__verifyFixture; }
});

test('a refused send (429) still does not open the form; "I already have a code" remains the way in', async () => {
  const limited = Object.assign(new Error('Too many requests. Try again later.'), { status: 429 });
  const auth = stubAuth({ sendError: limited });
  try {
    const { render, settle } = await loadHook(auth);
    let v = render();
    await v.sendCode();
    await settle();
    v = render();
    assert.equal(v.sent, false);
    assert.equal(v.entering, false, 'a failed send does not pretend a code is on its way');
    assert.equal(v.error, 'Too many requests. Try again later.');
    v.enterCode();
    v = render();
    assert.equal(v.entering, true);
    assert.equal(v.error, null, 'opening the form clears the send error');
    assert.deepEqual(auth.calls, ['send'], 'exactly one send; opening the form adds none');
  } finally { delete globalThis.__verifyFixture; }
});

test('sending still opens the form as before', async () => {
  const auth = stubAuth();
  try {
    const { render, settle } = await loadHook(auth);
    await render().sendCode();
    await settle();
    const v = render();
    assert.equal(v.sent, true);
    assert.equal(v.entering, true);
    assert.deepEqual(auth.calls, ['send']);
  } finally { delete globalThis.__verifyFixture; }
});

test('both panels offer the path before a send, and show the form without one', async (t) => {
  const modules = process.env.SOMEWHERE_TEST_STARTER_NODE_MODULES;
  if (!modules) { t.skip('Requires existing starter React dependencies; no downloads'); return; }
  const require = createRequire(join(modules, '../package.json'));
  const { createElement } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  for (const ui of ['styled', 'headless']) {
    const js = ts.transpileModule(read(files(ui), 'src/ui/VerifyEmail.tsx'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} };
    new Function('require', 'exports', js)(require, module.exports);
    const base = { status: 'unverified', code: '', sent: false, entering: false, pending: false, error: null, canSubmit: false,
      setCode() {}, sendCode: async () => {}, enterCode() {}, submit: async () => {}, retry() {} };
    const closed = renderToStaticMarkup(createElement(module.exports.VerifyEmailPanel, { verification: base }));
    assert.match(closed, /Email me a code/, ui);
    // A real, visible button that is not disabled: not just the words somewhere in the markup.
    assert.match(closed, /<button type="button"(?![^>]*\b(?:hidden|disabled)\b)[^>]*>I already have a code<\/button>/, ui);
    assert.doesNotMatch(closed, /id="verify-code"/, `${ui}: no code field before choosing`);
    const open = renderToStaticMarkup(createElement(module.exports.VerifyEmailPanel, { verification: { ...base, entering: true } }));
    assert.match(open, /id="verify-code"/, ui);
    assert.match(open, /autoComplete="one-time-code"|autocomplete="one-time-code"/, ui);
    assert.match(open, /from the latest email we sent you/, `${ui}: says which code works`);
    assert.match(open, /Send a new code/, ui);
    assert.doesNotMatch(open, /I already have a code/, ui);
    const sent = renderToStaticMarkup(createElement(module.exports.VerifyEmailPanel, { verification: { ...base, sent: true, entering: true } }));
    assert.match(sent, /Enter the 6-digit code we emailed you/, ui);
    const verified = renderToStaticMarkup(createElement(module.exports.VerifyEmailPanel, { verification: { ...base, status: 'verified', entering: true } }));
    assert.equal(verified, '', `${ui}: a verified account sees nothing`);
  }
});
