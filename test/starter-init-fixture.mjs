import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { CLI_PACKAGE_VERSION } from './local-cli-pack.mjs';

let bin;

// These tests cover init and project linking. The separate starter build tests
// install the real dependencies and the local CLI tarball.
export function starterInstallPath() {
  if (!bin) {
    bin = mkdtempSync(join(tmpdir(), 'sw-starter-install-'));
    process.on('exit', () => rmSync(bin, { recursive: true, force: true }));
    const script = join(bin, 'install.cjs');
    writeFileSync(script, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.deepEqual(process.argv.slice(2), ['install', '--no-audit', '--no-fund']);
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(pkg.devDependencies['@somewhere-cloud/cli'], ${JSON.stringify(CLI_PACKAGE_VERSION)});
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
