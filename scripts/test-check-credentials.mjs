import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { scanText } from './check-credentials.mjs';
const material = randomBytes(32).toString('hex');
for (const [kind, text] of [
  ['credential-literal', `const password = ${JSON.stringify(material)};`],
  ['platform-developer-key', 'const value = '+JSON.stringify(['sm','t_',material].join(''))],
  ['openai-api-key', 'const value = '+JSON.stringify(['s','k-',material].join(''))],
  ['bearer-token', ['Bear','er ',material].join('')],
  ['postgres-connection-string', ['postgres://test:',material,'@fixture.invalid/db'].join('')],
]) {
  const hits = scanText('fixture.ts', text);
  assert.ok(hits.some(hit => hit.kind === kind), 'planted shape must be detected');
  assert.ok(!JSON.stringify(hits).includes(material), 'findings must never contain matched material');
}
const planted = new URL('./credential-plant.ts', import.meta.url);
try {
  writeFileSync(planted, `const password = ${JSON.stringify(material)};\n`);
  const result = spawnSync(process.execPath, ['scripts/check-credentials.mjs'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.ok(result.status === 1, 'whole-repository check must reject an untracked planted credential');
  assert.ok(result.stderr.includes('scripts/credential-plant.ts:1:credential-literal'), 'failure must locate the planted literal');
  assert.ok(!result.stderr.includes(material) && !result.stdout.includes(material), 'CLI output must never expose matched material');
  console.log('PASS: planted fake refused; diagnostics contain path, line and kind only');
} finally { unlinkSync(planted); }
