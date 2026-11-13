import assert from 'node:assert/strict';
import ts from 'typescript';
import { createFeatureTemplate } from '../dist/lib/init-feature-template.js';
import { resolveInitSelection } from '../dist/lib/init-features.js';

const files = createFeatureTemplate(resolveInitSelection('auth'), { appName: 'Test' });
const config = files.find((file) => file.path === 'somewhere.auth.json');
assert.deepEqual(JSON.parse(config.content), { version: 1, signInPath: '/' });
const file = files.find((file) => file.path === 'src/auth/connection-return.ts');
const code = file.content.slice(0, file.content.indexOf('function readKept'));
const compiled = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { decideReturn } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const id = '3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f';
const path = `/mcp/consent?signin=${id}`;
const now = 1_000_000_000;

// The exact consent path is followed and remembered.
let d = decideReturn(path, null, now);
assert.deepEqual(d.result, { status: 'pending', path });
assert.deepEqual(d.keep, { path, at: now, sent: false });
// Kept across a later page load (social sign-in round trip).
assert.deepEqual(decideReturn(null, d.keep, now + 60_000).result, { status: 'pending', path });
// Stale: refused plainly, and forgotten.
d = decideReturn(null, { path, at: now, sent: false }, now + 11 * 60_000);
assert.equal(d.result.status, 'refused');
assert.match(d.result.message, /expired/);
assert.equal(d.keep, null);
// Already returned once: no second return; the same request again stops the loop.
assert.deepEqual(decideReturn(null, { path, at: now, sent: true }, now).result, { status: 'none' });
d = decideReturn(path, { path, at: now, sent: true }, now + 1000);
assert.equal(d.result.status, 'refused');
assert.equal(d.keep, null);
// Foreign or malformed returns are refused, never followed.
for (const bad of ['https://evil.example/mcp/consent?signin=' + id, '//evil.example' + path, '/settings', '/mcp/approve',
  path + '&x=1', path.toUpperCase(), '/mcp/consent?signin=not-a-uuid', '/\\evil.example', '', ' ' + path]) {
  const out = decideReturn(bad, null, now);
  assert.equal(out.result.status, 'refused', bad);
  assert.equal(out.keep, null);
}
// Nothing requested, nothing kept.
assert.deepEqual(decideReturn(null, null, now), { result: { status: 'none' }, keep: null });
console.log('PASS starter follows only the exact consent return, and refuses stale, looping and foreign values');
