import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { changelogBetween, decidePin, readProjectPin, recordPinIfMissing } from '../dist/lib/project-pin.js';
import { upgradeProject } from '../dist/commands/upgrade.js';

import { starterInstallPath } from './starter-init-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../dist/index.js');
const VERSION = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version;
const root = mkdtempSync(join(tmpdir(), 'project-pin-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function folder(files = {}) {
  const dir = join(root, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  return dir;
}

function run(cwd, args, env = {}) {
  const config = join(cwd, '..', `config-${n++}`);
  mkdirSync(config, { recursive: true });
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: 'http://127.0.0.1:9', SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1', ...env },
  });
}

const pkg = (spec) => ({ name: 'app', private: true, devDependencies: { '@somewhere-cloud/cli': spec, typescript: '5.9.3' } });

test('init pins the CLI installed for the starter test', () => {
  const dir = folder();
  const result = run(dir, ['init', '--name', 'pinned', '--json'], { PATH: starterInstallPath() });
  assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(written.devDependencies['@somewhere-cloud/cli'], VERSION);
  assert.equal(written.somewhere.cli_version, VERSION);
  assert.deepEqual(readProjectPin(dir), { spec: VERSION, source: 'package.json', versionOnly: true });
  // A pinned folder at its own version prints nothing extra.
  const lint = run(dir, ['lint']);
  assert.doesNotMatch(lint.stderr, /pinned to somewhere CLI/);
});

test('upgrade makes React required for both affected starter versions and calls for a lock refresh', () => {
  for (const version of ['0.38.123', '0.38.124']) {
    const dir = folder({ 'package.json': {
      name: 'my-starter', private: true, somewhere: { cli_version: version },
      dependencies: { '@somewhere-cloud/sdk': '0.14.2' },
      optionalDependencies: { react: '19.2.7', 'react-dom': '19.2.7', unrelated: '1.2.3' },
    } });
    const result = run(dir, ['upgrade', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.repairedStarter, true);
    assert.deepEqual(response.next, ['npm install']);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies, { '@somewhere-cloud/sdk': '0.14.2', react: '19.2.7', 'react-dom': '19.2.7' });
    assert.deepEqual(manifest.optionalDependencies, { unrelated: '1.2.3' });
    assert.equal(manifest.somewhere.cli_version, VERSION);
  }
});

test('a newer CLI in an older-pinned folder prints one line and keeps working', () => {
  const dir = folder({ 'package.json': pkg('0.0.1'), 'index.html': '<!doctype html><title>x</title>' });
  const result = run(dir, ['lint']);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stderr.split('\n').filter((line) => /pinned to somewhere CLI/.test(line));
  assert.deepEqual(lines, [`This project is pinned to somewhere CLI 0.0.1 (package.json); you are running ${VERSION}. Run \`somewhere upgrade\` to move the project to ${VERSION}.`]);
  assert.doesNotMatch(result.stdout, /pinned to/, 'stdout stays clean for pipes and --json');
});

test('the pinned version installed in node_modules runs the command', () => {
  const dir = folder({
    'package.json': pkg('0.0.1'),
    'node_modules/@somewhere-cloud/cli/package.json': { name: '@somewhere-cloud/cli', version: '0.0.1', bin: { somewhere: 'bin/somewhere.js' } },
    'node_modules/@somewhere-cloud/cli/bin/somewhere.js':
      "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), child: process.env.SOMEWHERE_PINNED_CLI }));\nprocess.exit(7);\n",
  });
  const result = run(dir, ['status', '--json']);
  assert.equal(result.status, 7, 'the pinned CLI\'s exit code is kept');
  assert.deepEqual(JSON.parse(result.stdout), { argv: ['status', '--json'], child: '1' });
  assert.match(result.stderr, new RegExp(`pinned to somewhere CLI 0\\.0\\.1 \\(package\\.json\\); running its installed 0\\.0\\.1 instead of ${VERSION.replace(/\./g, '\\.')}\\. Run \`somewhere upgrade\``));
  for (const args of [['deploy'], ['deploy', '--new']]) {
    const decision = decidePin(dir, VERSION, ['node', 'somewhere', ...args], {});
    assert.equal(decision.delegate, null);
    assert.match(decision.notice, /deploy is using the running CLI/);
  }
  assert.equal(decidePin(dir, VERSION, ['node', 'somewhere', 'init'], {}).delegate, null);
  // upgrade, update, init and --version never hand off.
  const version = run(dir, ['--version']);
  assert.equal(version.stdout.trim(), VERSION);
  assert.equal(version.stderr, '');
});

test('a CLI older than the pin says how to get the pinned one', () => {
  const dir = folder({ '.somewhere.json': { project_id: 'p', name: 'p', subdomain: 'p', cli_version: '99.0.0' } });
  const decision = decidePin(dir, VERSION, ['node', 'somewhere', 'deploy'], {});
  assert.equal(decision.delegate, null);
  assert.equal(decision.notice, `This project is pinned to somewhere CLI 99.0.0 (.somewhere.json); you are running ${VERSION}, which is older. Use \`npx -y @somewhere-cloud/cli@99.0.0 <command>\`.`);
  assert.deepEqual(decidePin(dir, VERSION, ['node', 'somewhere', 'upgrade'], {}), { notice: null, delegate: null });
  assert.deepEqual(decidePin(dir, VERSION, ['node', 'somewhere', 'deploy'], { SOMEWHERE_PINNED_CLI: '1' }), { notice: null, delegate: null });
});

test('package.json wins over .somewhere.json; a range that includes the running CLI is satisfied', () => {
  const dir = folder({ 'package.json': pkg(`^${VERSION}`), '.somewhere.json': { project_id: 'p', name: 'p', subdomain: 'p', cli_version: '0.0.1' } });
  assert.deepEqual(readProjectPin(dir), { spec: `^${VERSION}`, source: 'package.json' });
  assert.deepEqual(decidePin(dir, VERSION, ['node', 'somewhere', 'deploy'], {}), { notice: null, delegate: null });
  assert.equal(readProjectPin(folder({ 'package.json': pkg('latest') })), null, 'a tag is not a pin');
});

test('the first deploy pins a linked folder in .somewhere.json, never in package.json', () => {
  const linked = folder({ 'package.json': { name: 'app', dependencies: {} }, '.somewhere.json': { project_id: 'p', name: 'p', subdomain: 'p' } });
  assert.equal(recordPinIfMissing(linked, '0.38.15'), true);
  assert.equal(JSON.parse(readFileSync(join(linked, '.somewhere.json'), 'utf8')).cli_version, '0.38.15');
  assert.deepEqual(JSON.parse(readFileSync(join(linked, 'package.json'), 'utf8')), { name: 'app', dependencies: {} });
  assert.equal(recordPinIfMissing(linked, '0.39.0'), false, 'an existing pin is never moved by deploy');
  assert.equal(recordPinIfMissing(folder({ 'package.json': pkg('0.38.1') }), '0.38.15'), false);
  assert.equal(recordPinIfMissing(folder({ 'index.html': 'x' }), '0.38.15'), false, 'an unlinked folder has nowhere to record it');
});

const CHANGELOG = '# Changelog\n\n## 0.38.15\n\n- fifteen\n\n## 0.38.14\n\n- fourteen\n\n## 0.38.13\n\n- thirteen\n';

test('changelogBetween keeps the releases after the pin up to the new version', () => {
  assert.deepEqual(changelogBetween(CHANGELOG, '0.38.13', '0.38.15').map((e) => e.version), ['0.38.15', '0.38.14']);
  assert.deepEqual(changelogBetween(CHANGELOG, '0.38.15', '0.38.15'), []);
  assert.equal(changelogBetween(CHANGELOG, '0.38.14', '0.38.15')[0].body, '- fifteen');
});

test('upgrade moves every recorded pin, lists the changes and leaves skills alone', () => {
  const dir = folder({
    'package.json': pkg('0.38.13'),
    '.somewhere.json': { project_id: 'p', name: 'p', subdomain: 'p', cli_version: '0.38.13' },
    'skills-lock.json': '{"kept":true}\n',
  });
  const result = upgradeProject(dir, '0.38.15', () => CHANGELOG);
  assert.deepEqual(result.updated, ['package.json', '.somewhere.json']);
  assert.deepEqual(result.changes.map((e) => e.version), ['0.38.15', '0.38.14']);
  assert.deepEqual(result.next, ['npm install']);
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).devDependencies['@somewhere-cloud/cli'], '0.38.15');
  assert.equal(JSON.parse(readFileSync(join(dir, '.somewhere.json'), 'utf8')).cli_version, '0.38.15');
  assert.equal(readFileSync(join(dir, 'skills-lock.json'), 'utf8'), '{"kept":true}\n');
  assert.deepEqual(upgradeProject(dir, '0.38.15', () => CHANGELOG).updated, [], 'already current');
  assert.throws(() => upgradeProject(dir, '0.38.14', () => CHANGELOG), /older than the project's pin/);
});

test('somewhere upgrade --json reads the CHANGELOG.md shipped in the package', () => {
  const dir = folder({ 'package.json': pkg('0.0.1') });
  const result = run(dir, ['upgrade', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /pinned to somewhere CLI/, 'upgrade itself prints no mismatch line');
  const body = JSON.parse(result.stdout);
  assert.equal(body.from, '0.0.1');
  assert.equal(body.to, VERSION);
  assert.equal(body.changes[0].version, VERSION, 'the newest entry is the version being moved to');
  const files = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).files;
  assert.ok(files.includes('CHANGELOG.md'), 'CHANGELOG.md ships in the package');
  assert.ok(existsSync(join(here, '../CHANGELOG.md')));
});

test('upgrade in a folder with no pin and no link refuses with the way to add one', () => {
  const dir = folder({ 'index.html': 'x' });
  const result = run(dir, ['upgrade', '--json']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /UPGRADE_REFUSED/);
});


test('a version-only pin delegates commands through npm and upgrade changes only the version string', { skip: process.platform === 'win32' }, () => {
  const dir = folder({
    'package.json': { name: 'app', somewhere: { cli_version: '0.38.12' } },
    'bin/npx': '#!/usr/bin/env node\nconsole.log(JSON.stringify({argv: process.argv.slice(2), child: process.env.SOMEWHERE_PINNED_CLI})); process.exit(7);\n',
  });
  chmodSync(join(dir, 'bin/npx'), 0o755);
  const result = run(dir, ['deploy', '--message', 'name with spaces'], { PATH: [join(dir, 'bin'), process.env.PATH].join(delimiter) });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: ['--yes', '--prefer-offline', '--ignore-scripts', '@somewhere-cloud/cli@0.38.12', 'deploy', '--message', 'name with spaces'],
    child: '1',
  });
  assert.equal(existsSync(join(dir, 'node_modules')), false);
  const moved = upgradeProject(dir, '0.38.15', () => CHANGELOG);
  assert.deepEqual(moved.updated, ['package.json']);
  assert.deepEqual(moved.next, []);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')), { name: 'app', somewhere: { cli_version: '0.38.15' } });
});
