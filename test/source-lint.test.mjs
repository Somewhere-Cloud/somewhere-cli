import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { lintProject } from '../dist/lib/source-lint.js';
import { genericLint } from '../dist/lib/generic-lint.js';
import { collectFiles } from '../dist/lib/files.js';
import { collectNotices } from '../dist/lib/notify/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const vendor = require('../runtime/source-lint.cjs');
const fixtures = JSON.parse(readFileSync(new URL('fixtures/source-lint.json', import.meta.url), 'utf8'));
function project(files, functions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'source-lint-'));
  for (const [file, source] of Object.entries({ ...files, ...functions })) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), source);
  }
  return dir;
}

for (const fixture of fixtures) test(fixture.name, async () => {
  const dir = project(fixture.files, fixture.functions);
  const result = await lintProject(dir);
  assert.deepEqual(result.findings.map(({ rule, file, line }) => ({ rule, file, line })), fixture.expected);
  assert.equal(result.ok, true, 'findings are warnings');
  assert.equal(result.generic.status, 'not-requested');
  assert.equal(result.coverage.authorization, 'not-assessed');
  const collected = collectFiles(dir);
  const shared = await vendor.lintSourceSnapshot(collected.files, collected.functions);
  for (const key of Object.keys(shared)) assert.deepEqual(result[key], shared[key], key);
  assert.ok(!JSON.stringify(result).includes('sk_live_Fx7Qm2Lp9Rz4Kd8Wn3Ty6Hv1Bc5'));
});

test('offline CLI needs no account, makes no network attempt and leaves source unchanged', () => {
  const dir = project({ 'src/main.ts': 'export const n = 1;' });
  const scratch = mkdtempSync(join(tmpdir(), 'source-lint-offline-'));
  const marker = join(scratch, 'network-attempts');
  const preload = join(scratch, 'offline.mjs');
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';\nimport net from 'node:net';\nimport tls from 'node:tls';\nimport { syncBuiltinESMExports } from 'node:module';\nconst fail = () => { appendFileSync(${JSON.stringify(marker)}, 'attempt\\n'); throw new Error('Network forbidden during lint'); };\nglobalThis.fetch = fail; net.connect = fail; net.createConnection = fail; net.Socket.prototype.connect = fail; tls.connect = fail; syncBuiltinESMExports();\n`);
  const run = spawnSync(process.execPath, ['--import', preload, join(root, 'dist/index.js'), 'lint', dir, '--json'], {
    encoding: 'utf8', env: { ...process.env, SOMEWHERE_CONFIG_DIR: join(scratch, 'config'), SOMEWHERE_NO_NOTIFICATIONS: '', CI: '' }, timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).ok, true);
  assert.ok(!readdirSync(scratch).includes('network-attempts'));
  assert.deepEqual(readdirSync(dir), ['src']);
  assert.equal(readFileSync(join(dir, 'src/main.ts'), 'utf8'), 'export const n = 1;');
});

test('lint suppresses update checks on a terminal too', async () => {
  let calls = 0;
  assert.deepEqual(await collectNotices(['node', 'somewhere', 'lint'], { isTTY: true, outdatedWarning: async () => { calls++; return 'unexpected'; } }), []);
  assert.equal(calls, 0);
});

test('incomplete source collection and missing requested generic checker are not clean checks', async () => {
  const dir = project({ 'src/main.ts': 'export const n = 1;' });
  symlinkSync(join(dir, 'src/main.ts'), join(dir, 'src/alias.ts'));
  const result = await lintProject(dir, { generic: true });
  assert.equal(result.ok, false);
  assert.equal(result.skipped[0].path, 'src/alias.ts');
  assert.equal(result.generic.status, 'unavailable');
});

test('installed generic checker diagnostics are warnings; crashes and malformed output fail visibly', () => {
  const dir = project({ 'src/main.ts': 'const unused = 1;' });
  const launcher = join(dir, 'node_modules/oxlint/bin/oxlint');
  mkdirSync(dirname(launcher), { recursive: true });
  const diagnostics = [{ code: 'eslint(no-unused-vars)', message: 'Unused variable', filename: 'src/main.ts', labels: [{ span: { line: 1 } }], help: 'Remove it.', url: 'https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-vars' }];
  writeFileSync(launcher, `console.log(${JSON.stringify(JSON.stringify({ diagnostics }))}); process.exitCode = 1;`);
  const good = genericLint(dir);
  assert.equal(good.status, 'completed');
  assert.deepEqual(good.findings.map(({ file, line, severity }) => ({ file, line, severity })), [{ file: 'src/main.ts', line: 1, severity: 'warning' }]);
  writeFileSync(launcher, 'process.exitCode = 2;');
  assert.equal(genericLint(dir).status, 'failed');
  writeFileSync(launcher, 'console.log("not JSON");');
  assert.equal(genericLint(dir).status, 'failed');
});

test('lint does not read binary assets, while deploy collection still does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-lint-binary-'));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'index.html'), '<script type="module" src="/main.js"></script>');
  writeFileSync(join(dir, 'main.js'), 'console.log(1);');
  writeFileSync(join(dir, 'public', 'hero.png'), Buffer.alloc(4096, 7));
  const deploy = collectFiles(dir);
  const lintOnly = collectFiles(dir, { readBinary: false });
  const key = Object.keys(deploy.binaryFiles).find((name) => name.endsWith('hero.png'));
  assert.ok(key, 'the asset is collected as binary');
  assert.equal(deploy.binaryFiles[key], Buffer.alloc(4096, 7).toString('base64'));
  assert.equal(lintOnly.binaryFiles[key], '');
  assert.deepEqual(lintOnly.files, deploy.files);
  assert.deepEqual(lintOnly.skipped, deploy.skipped);
  const result = await lintProject(dir);
  assert.equal(result.ok, true);
  assert.equal(result.checked_files, Object.keys(deploy.files).length + Object.keys(deploy.functions).length);
});

// The help text names every rule the vendored lint can report, so it cannot
// fall behind a re-vendor that adds one.
test('lint --help names every vendored source-lint rule', () => {
  const fixtures = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'source-lint.json'), 'utf8'));
  const rules = [...new Set(fixtures.flatMap((f) => f.expected.map((e) => e.rule)))].sort();
  const help = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js'), 'lint', '--help'], { encoding: 'utf8', env: { ...process.env, SOMEWHERE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'sw-lint-help-')) } }).stdout.replace(/\s+/g, ' ');
  const words = {
    'somewhere/source-secret': 'credentials in source',
    'somewhere/schema-declaration': 'schema declarations',
    'somewhere/index-route': 'directory index routes',
    'somewhere/request-ownership': 'row ownership',
    'somewhere/sequential-email': 'awaited inside a loop',
  };
  assert.deepEqual(rules, Object.keys(words).sort(), 'a new vendored rule needs a help phrase');
  for (const [rule, phrase] of Object.entries(words)) assert.ok(help.includes(phrase), `help mentions ${rule}`);
});

