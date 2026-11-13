import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Playwright files a test under the frame that calls test(); a forwarding wrapper
// in this package once placed every test there, so `somewhere test <file>` found none.
test('a spec using the testing test() is selected by its file path', () => {
  const cliRoot = fileURLToPath(new URL('..', import.meta.url));
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'file-filter-'));
  mkdirSync(join(dir, 'tests'));
  symlinkSync(join(cliRoot, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'tests', 'one.spec.ts'), `import { test } from ${JSON.stringify(join(cliRoot, 'dist/testing.js'))};\ntest('one', async () => {});\n`);
  writeFileSync(join(dir, 'tests', 'two.spec.ts'), `import { test } from ${JSON.stringify(join(cliRoot, 'dist/testing.js'))};\ntest('two', async () => {});\n`);
  writeFileSync(join(dir, 'pw.config.cjs'), `module.exports = ${JSON.stringify({ testDir: join(dir, 'tests'), testMatch: '**/*.spec.ts' })};\n`);
  const cli = join(cliRoot, 'node_modules/@playwright/test/cli.js');
  const run = spawnSync(process.execPath, [cli, 'test', '--config', 'pw.config.cjs', '--list', 'tests/one.spec.ts'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /one\.spec\.ts:2:\d+ › one/);
  assert.match(run.stdout, /Total: 1 test in 1 file/);
});
