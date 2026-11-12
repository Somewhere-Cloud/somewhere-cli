import assert from 'node:assert/strict';
import { createFeatureTemplate } from '../dist/lib/init-feature-template.js';
import { resolveInitSelection } from '../dist/lib/init-features.js';
import ts from 'typescript';
const files = createFeatureTemplate(resolveInitSelection('auth'), { appName: 'Test' });
const file = files.find(file => file.path === 'src/auth/magic-link.ts');
assert.ok(file);
const code = file.content.slice(file.content.indexOf('export function landingTarget'), file.content.indexOf('/** The link this tab'));
const compiled = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { landingTarget } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const origin = 'https://app.somewhere.site';
for (const target of ['//evil.example/path', origin + '//evil.example/path', '/\\evil.example', 'https://evil.example/']) {
  const result = landingTarget('?redirect_uri=' + encodeURIComponent(target), origin);
  assert.equal(new URL(result, origin).origin, origin, target);
  assert.equal(result, '/');
}
console.log('PASS generated landing rejects cross-origin and network-path destinations');
