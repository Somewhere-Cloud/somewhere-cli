// A generated starter pins @somewhere-cloud/cli to the version being built
// (tsk_a4641877). On a version PR that version is not on npm yet, so a test
// that installs the starter installs THIS working tree instead: one `npm pack`
// per test process, swapped in after asserting the pin is the package version.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CLI_PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

let tarball;
function localCliTarball() {
  if (tarball) return tarball;
  const dest = mkdtempSync(join(tmpdir(), 'sw-local-cli-pack-'));
  process.on('exit', () => rmSync(dest, { recursive: true, force: true }));
  const done = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--silent', '--pack-destination', dest],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  if (done.error) throw done.error;
  if (done.status !== 0) throw new Error(`npm pack exited ${done.status}: ${done.stderr}`);
  tarball = join(dest, done.stdout.trim().split('\n').pop());
  return tarball;
}

/** Assert the starter in `dir` pins this CLI's version, then point it at the local pack. */
export function pinStarterToLocalCli(dir) {
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.devDependencies?.['@somewhere-cloud/cli'], CLI_PACKAGE_VERSION, 'the starter pins the CLI version being built');
  pkg.devDependencies['@somewhere-cloud/cli'] = `file:${localCliTarball()}`;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}
