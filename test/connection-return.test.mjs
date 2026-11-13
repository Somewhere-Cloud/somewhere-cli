import assert from 'node:assert/strict';
import ts from 'typescript';
import { createFeatureTemplate } from '../dist/lib/init-feature-template.js';
import { resolveInitSelection } from '../dist/lib/init-features.js';

const files = createFeatureTemplate(resolveInitSelection('auth'), { appName: 'Test' });
const config = files.find((file) => file.path === 'somewhere.auth.json');
assert.deepEqual(JSON.parse(config.content), { version: 1, signInPath: '/' });
const source = files.find((file) => file.path === 'src/auth/connection-return.ts').content;
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
let copies = 0;
/** A fresh module instance (its once-per-page memo starts empty). */
const load = () => import(`data:text/javascript;base64,${Buffer.from(compiled + `\n// copy ${copies++}`).toString('base64')}`);
const { decideReturn, parseKept, safeReturn } = await load();

const id = '3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f';
const path = `/mcp/consent?signin=${id}`;
const now = 1_000_000_000;
const KEY = '__Host-sw_connection_return';
const cookie = (value, name = KEY) => `${name}=${encodeURIComponent(JSON.stringify(value))}`;

// The exact consent path is followed and remembered.
let d = decideReturn(path, null, now);
assert.deepEqual(d.result, { status: 'pending', path, at: now });
assert.deepEqual(d.keep, { path, at: now, sent: false });
assert.deepEqual(decideReturn(null, d.keep, now + 60_000).result, { status: 'pending', path, at: now });
// Reopening the same request keeps its original start time.
assert.equal(decideReturn(path, { path, at: now, sent: false }, now + 60_000).keep.at, now);
// Stale: refused plainly, and forgotten.
d = decideReturn(null, { path, at: now, sent: false }, now + 11 * 60_000);
assert.equal(d.result.status, 'refused');
assert.match(d.result.message, /expired/);
assert.equal(d.keep, null);
// Already returned once: no second return, the marker is kept, and the same request again stops the loop.
d = decideReturn(null, { path, at: now, sent: true }, now + 1000);
assert.deepEqual(d.result, { status: 'none' });
assert.deepEqual(d.keep, { path, at: now, sent: true });
d = decideReturn(path, d.keep, now + 2000);
assert.equal(d.result.status, 'refused');
assert.equal(d.keep, null);
// Foreign or malformed address-bar returns are refused, never followed.
for (const bad of ['https://evil.example/mcp/consent?signin=' + id, '//evil.example' + path, '/settings', '/mcp/approve',
  path + '&x=1', path.toUpperCase(), '/mcp/consent?signin=not-a-uuid', '/\\evil.example', '', ' ' + path]) {
  assert.equal(safeReturn(bad), false, bad);
  const out = decideReturn(bad, null, now);
  assert.equal(out.result.status, 'refused', bad);
  assert.equal(out.keep, null);
}

// M1: a hostile cookie value is never trusted. Same single validator as the address bar.
const hostile = [
  cookie({ path: 'https://evil.example/login', at: now, sent: false }),
  cookie({ path: '//evil.example/x', at: now, sent: false }),
  cookie({ path: 'javascript:alert(1)', at: now, sent: false }),
  cookie({ path, at: 'now', sent: false }),
  cookie({ path, at: Infinity, sent: false }),
  cookie({ path, at: now, sent: 'no' }),
  // The old, non-__Host- name a sibling site could set for the parent domain.
  cookie({ path, at: now, sent: false }, 'sw_connection_return'),
  // Duplicates (one planted, one genuine) are refused rather than picking one.
  `${cookie({ path, at: now, sent: false })}; ${cookie({ path: 'https://evil.example/', at: now, sent: false })}`,
  `${KEY}=%7Bnot-json`,
];
for (const header of hostile) {
  const kept = parseKept(header);
  assert.equal(kept, null, header);
  assert.deepEqual(decideReturn(null, kept, now).result, { status: 'none' }, header);
}
// Even if a foreign value reached the decision directly, it is not followed.
assert.deepEqual(decideReturn(null, { path: 'https://evil.example/login', at: now, sent: false }, now).result, { status: 'none' });
assert.deepEqual(parseKept(cookie({ path, at: now, sent: false })), { path, at: now, sent: false });

// End to end through the browser entry points with a planted cookie: nothing navigates off this origin.
function browser(cookieHeader, href = 'https://app.somewhere.site/') {
  const replaced = [];
  const written = [];
  globalThis.document = { get cookie() { return cookieHeader; }, set cookie(v) { written.push(v); } };
  globalThis.window = { location: { href, origin: new URL(href).origin, replace: (u) => replaced.push(u) },
    history: { state: null, replaceState() {} } };
  return { replaced, written };
}
{
  const page = browser(cookie({ path: 'https://evil.example/login', at: Date.now(), sent: false }));
  const m = await load();
  assert.deepEqual(m.authReturn(), { status: 'none' });
  assert.match(m.returnToConnection({ path: 'https://evil.example/login', at: Date.now() }), /not followed/);
  assert.deepEqual(page.replaced, []);
}
{
  const page = browser(cookie({ path, at: Date.now(), sent: false }));
  const m = await load();
  const back = m.authReturn();
  assert.equal(back.status, 'pending');
  assert.equal(m.returnToConnection(back), null);
  assert.deepEqual(page.replaced, ['https://app.somewhere.site' + path]);
  assert.ok(page.written.every((v) => v.startsWith(KEY + '=') && /; Path=\/; SameSite=Lax; Secure$/.test(v) && !/Domain=/i.test(v)));
}
{
  // F1: a page left open past the lifetime refuses at the moment it would navigate.
  const page = browser('');
  const m = await load();
  assert.match(m.returnToConnection({ path, at: Date.now() - 11 * 60_000 }), /expired/);
  assert.deepEqual(page.replaced, []);
}
delete globalThis.document;
delete globalThis.window;

// Same class in the sign-in link landing: the target re-read from history state is validated again.
const magic = files.find((file) => file.path === 'src/auth/magic-link.ts').content;
assert.match(magic, /target: landingTarget\('\?redirect_uri=' \+ encodeURIComponent\(kept\.target\), window\.location\.origin\)/);
console.log('PASS starter follows only the exact consent return from any source, and refuses hostile cookies, stale, looping and foreign values');
