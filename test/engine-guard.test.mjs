import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimumNodeVersion, olderThan, unsupportedNodeMessage } from '../bin/engine.js';

// The bin checks the declared engine before importing the CLI and its bundled
// dependencies, which on an older Node.js die with an unrelated internal error.
// Real older/minimum Node binaries are optional inputs:
//   SOMEWHERE_TEST_NODE_UNSUPPORTED=<node 20 binary> SOMEWHERE_TEST_NODE_MINIMUM=<node 22.19.0 binary>
const bin = join(dirname(fileURLToPath(import.meta.url)), '../bin/somewhere.js');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the guard minimum is package.json engines.node', () => {
  assert.equal(`>=${minimumNodeVersion()}`, pkg.engines.node);
});

test('version comparison', () => {
  for (const [version, older] of [['20.20.2', true], ['22.18.0', true], ['22.19.0', false], ['22.19.1', false], ['22.20.0', false], ['24.0.0', false], ['18.20.4', true]]) {
    assert.equal(olderThan(version, '22.19.0'), older, version);
  }
});

function run(node, args) {
  return spawnSync(node, [bin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SOMEWHERE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'sw-engine-')), NO_COLOR: '1', CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
}

test('an unsupported Node.js gets the supported-version message, not a dependency crash', { skip: !process.env.SOMEWHERE_TEST_NODE_UNSUPPORTED && 'SOMEWHERE_TEST_NODE_UNSUPPORTED is not set' }, () => {
  const node = process.env.SOMEWHERE_TEST_NODE_UNSUPPORTED;
  const version = spawnSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(olderThan(version, minimumNodeVersion()), `${version} must be older than the minimum`);
  for (const args of [['--version'], ['init', '--catalog', '--json'], ['deploy', '--json']]) {
    const result = run(node, args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `✗ ${unsupportedNodeMessage(version, minimumNodeVersion())}\n`);
  }
});

test('the minimum supported Node.js runs the CLI', { skip: !process.env.SOMEWHERE_TEST_NODE_MINIMUM && 'SOMEWHERE_TEST_NODE_MINIMUM is not set' }, () => {
  const node = process.env.SOMEWHERE_TEST_NODE_MINIMUM;
  const version = spawnSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(version, minimumNodeVersion());
  assert.equal(run(node, ['--version']).stdout.trim(), pkg.version);
  const catalog = run(node, ['init', '--catalog', '--json']);
  assert.equal(catalog.status, 0, catalog.stderr);
  assert.ok(JSON.parse(catalog.stdout));
});

test('the running Node.js runs the CLI', () => {
  assert.equal(run(process.execPath, ['--version']).stdout.trim(), pkg.version);
});
