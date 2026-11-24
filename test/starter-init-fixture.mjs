import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { CLI_PACKAGE_VERSION } from './local-cli-pack.mjs';

let bin;

// These tests cover init and project linking. The separate starter build tests
// install the real app dependencies.
export function starterInstallPath() {
  if (!bin) {
    bin = mkdtempSync(join(tmpdir(), 'sw-starter-install-'));
    process.on('exit', () => rmSync(bin, { recursive: true, force: true }));
    const script = join(bin, 'install.cjs');
    writeFileSync(script, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.deepEqual(process.argv.slice(2), ['install', '--no-audit', '--no-fund']);
assert.equal(pkg.somewhere.cli_version, ${JSON.stringify(CLI_PACKAGE_VERSION)});
const expectedCli = pkg.scripts?.test === 'node tests/starter.mjs' ? pkg.somewhere.cli_version : undefined;
assert.equal(pkg.devDependencies?.['@somewhere-cloud/cli'], expectedCli);
`);
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'npm.cmd'), '@node "%~dp0install.cjs" %*\r\n');
    } else {
      const npm = join(bin, 'npm');
      writeFileSync(npm, '#!/bin/sh\nexec node "$(dirname "$0")/install.cjs" "$@"\n');
      chmodSync(npm, 0o700);
    }
  }
  return [bin, process.env.PATH].join(delimiter);
}

export function assertInitCreated(stdout, project) {
  const firstNewline = stdout.indexOf('\n');
  assert.ok(firstNewline >= 0, 'creation receipt precedes the final result');
  assert.deepEqual(JSON.parse(stdout.slice(0, firstNewline)), {
    event: 'project_created', project_id: project.id, ...project,
  });
  return JSON.parse(stdout.slice(firstNewline + 1));
}

// Install the starter dependencies with the exact packed CLI during a release check,
// when the starter's pinned CLI version is still absent from the registry.
export function installStarterDependencies(specs, cwd) {
  const tarball = process.env.SOMEWHERE_TEST_PACKED_TARBALL;
  const packages = tarball
    ? [...specs.filter(spec => !spec.startsWith('@somewhere-cloud/cli@')), tarball]
    : specs;
  const windows = process.platform === 'win32';
  const done = spawnSync(windows ? 'npm.cmd' : 'npm',
    ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel', 'error', ...packages],
    { cwd, stdio: 'ignore', shell: windows });
  if (done.error) throw done.error;
  if (done.status !== 0) throw new Error(`npm install exited ${done.status}`);
}
