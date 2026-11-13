import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publicProjection, assertBehaviorParity, assertPublicArtifact } from '../scripts/public-projection.mjs';

test('public artifacts reject internal references rather than rewriting literal data', () => {
  for (const marker of ['tsk_abcd1234', 'pfb_12345678abcd']) {
    const source = `export const text = "${marker}";`;
    const projected = publicProjection(source);
    assertBehaviorParity(source, projected);
    assert.equal(projected, source);
    assert.throws(() => assertPublicArtifact(projected, 'fixture'), /internal task or feedback reference/);
  }
  assertPublicArtifact('export const text = "public example";', 'fixture');
});

test('only parsed comments are removed; literal bytes and tokens survive', async () => {
  const marker = ['tsk', 'abc123'].join('_');
  const source = `// ${marker}\nexport const text = "start\\n//keep this data\\nend";\nexport const task = "${marker}";\nexport const pattern = /${marker}/;\nexport const ${marker} = 1;\nexport const raw = String.raw\`\\s+\\n\`;`;
  const projected = publicProjection(source);
  assertBehaviorParity(source, projected);
  const module = await import('data:text/javascript;base64,' + Buffer.from(projected).toString('base64'));
  assert.equal(module.text, 'start\n//keep this data\nend');
  assert.equal(module.task, marker);
  assert.equal(module.pattern.source, marker);
  assert.equal(module[marker], 1);
  assert.equal(module.raw, String.raw`\s+\n`);
  assert.ok(!projected.split('\n')[0].includes(marker));
  assert.throws(() => assertBehaviorParity(source, projected.replace('keep this data', 'changed')), /token mismatch/);
});

test('vendor --check rejects a changed public literal even with its digest unchanged', t => {
  const root = mkdtempSync(join(tmpdir(), 'vendor-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'source/shared'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src/lib/vendor'), { recursive: true });
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
  for (const file of ['vendor-repro-guidance.mjs', 'public-projection.mjs']) {
    copyFileSync(new URL('../scripts/' + file, import.meta.url), join(root, 'scripts', file));
  }
  const source = readFileSync(new URL('../src/lib/vendor/repro-guidance.ts', import.meta.url), 'utf8');
  writeFileSync(join(root, 'source/shared/repro-guidance.ts'), source);
  writeFileSync(join(root, 'src/lib/vendor/repro-guidance.ts'), source.replace('somewhere.repro/1', 'different.repro/1'));
  copyFileSync(new URL('../src/lib/vendor/REPRO-GUIDANCE-VENDOR.json', import.meta.url), join(root, 'src/lib/vendor/REPRO-GUIDANCE-VENDOR.json'));
  const run = spawnSync(process.execPath, [join(root, 'scripts/vendor-repro-guidance.mjs'), join(root, 'source'), '--check'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /executable token mismatch/);
});
