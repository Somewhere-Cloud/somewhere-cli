import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packCli } from './pack-cli.mjs';

const fixture = mkdtempSync(join(tmpdir(), 'somewhere-packed-suite-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmOptions = { encoding: 'utf8', shell: process.platform === 'win32' };
try {
  const [existingTarball, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Pass one packed CLI tarball.');
  const tarball = existingTarball ? resolve(existingTarball) : join(fixture, packCli(fixture).filename);
  execFileSync(npm, [
    'install', '--prefix', fixture, '--offline', '--ignore-scripts',
    '--no-audit', '--no-fund', tarball,
  ], npmOptions);
  const installed = join(fixture, 'node_modules', '@somewhere-cloud', 'cli');
  console.log(`Testing packed CLI ${tarball} installed in an isolated prefix.`);
  const hook = new URL('./use-packed-entrypoints.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [
    '--test', '--test-concurrency=1', 'test/*.test.mjs',
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      SOMEWHERE_TEST_PACKED_CLI: installed,
      SOMEWHERE_TEST_PACKED_TARBALL: tarball,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + hook.href].filter(Boolean).join(' '),
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
