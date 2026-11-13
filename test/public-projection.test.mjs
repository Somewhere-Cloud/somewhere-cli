import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publicProjection, assertBehaviorParity, assertPublicArtifact, assertPublicPackage } from '../scripts/public-projection.mjs';

test('the npm shipped-file list is scanned without file-type exclusions', t => {
  const root = mkdtempSync(join(tmpdir(), 'public-package-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'public-scan-fixture', version: '1.0.0', files: ['files'] }));
  mkdirSync(join(root, 'files/templates'), { recursive: true });
  for (const file of ['a.js', 'a.cjs', 'a.mjs', 'a.ts', 'a.d.ts', 'a.json', 'a.md', 'templates/a.template']) {
    const path = join(root, 'files', file);
    writeFileSync(path, 'pfb_12345678abcd');
    assert.throws(() => assertPublicPackage(root), /internal task or feedback reference/);
    writeFileSync(path, 'public example');
  }
  assert.equal(assertPublicPackage(root).files_scanned, 9);
});

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

test('browser probe extraction projects the executable script before serializing it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'browser-probe-projection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'runtime', 'platform/worker/src/utils']) mkdirSync(join(root, dir), { recursive: true });
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
  for (const file of ['extract-runtime.mjs', 'public-projection.mjs']) copyFileSync(new URL('../scripts/' + file, import.meta.url), join(root, 'scripts', file));
  const script = '(() => {\n// pfb_12345678abcd\nconst outline = []; outline.push("keep // literal data"); return { outline, testid_map: {} };\n})()';
  writeFileSync(join(root, 'platform/worker/src/utils/browser-dom-outline.ts'),
    'export function computeOutlineVisibility(info: OutlineVisibilityInput): { visible: boolean; disabled: boolean } {\nreturn { visible: true, disabled: false };\n}\nconst DOM_OUTLINE_SCRIPT = `' + script + '`;\n');
  writeFileSync(join(root, 'platform/worker/src/utils/browser-test-steps.ts'), 'const MAX_OUTLINE_NODES = 20;');
  const run = spawnSync(process.execPath, [join(root, 'scripts/extract-runtime.mjs'), join(root, 'platform')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const generated = readFileSync(join(root, 'runtime/browser-probes.mjs'), 'utf8');
  assertPublicArtifact(generated, 'browser probe');
  const module = await import('data:text/javascript;base64,' + Buffer.from(generated).toString('base64'));
  assertBehaviorParity(script, module.DOM_OUTLINE_SCRIPT, 'browser-probe.js');
  assert.ok(module.DOM_OUTLINE_SCRIPT.includes('keep // literal data'));
  assert.throws(() => assertBehaviorParity(script, module.DOM_OUTLINE_SCRIPT.replace('keep // literal data', 'changed'), 'browser-probe.js'), /token mismatch/);
});
