import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = mkdtempSync(join(tmpdir(), 'somewhere-packed-suite-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmOptions = { encoding: 'utf8', shell: process.platform === 'win32' };
try {
  const [pack] = JSON.parse(execFileSync(npm, [
    'pack', '--ignore-scripts', '--json', '--pack-destination', fixture,
  ], npmOptions));
  execFileSync(npm, [
    'install', '--prefix', fixture, '--offline', '--ignore-scripts', '--omit=dev',
    '--no-audit', '--no-fund', join(fixture, pack.filename),
  ], npmOptions);
  const installed = join(fixture, 'node_modules', '@somewhere-cloud', 'cli');
  console.log(`Testing packed CLI ${pack.version} (${pack.entryCount} files) installed in an isolated prefix.`);
  const hook = new URL('./use-packed-entrypoints.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [
    '--test', '--test-concurrency=1', 'test/*.test.mjs',
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      SOMEWHERE_TEST_PACKED_CLI: installed,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + hook.href].filter(Boolean).join(' '),
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
