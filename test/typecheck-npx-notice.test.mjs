import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fetching TypeScript with npx is a network step: it is announced on stderr
// (stdout stays the JSON result), including for `typecheck --deploy --json`.
// A fake npx stands in, so nothing is fetched.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

function runDeployCheck(withTypeScript) {
  const base = mkdtempSync(join(tmpdir(), 'sw-npx-notice-'));
  const dir = join(base, 'app'), bin = join(base, 'bin');
  mkdirSync(join(dir, 'api'), { recursive: true }); mkdirSync(bin);
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho called > "${join(base, 'npx-called')}"\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'api/hello.ts'), 'export default async () => new Response("hi");\n');
  if (withTypeScript) {
    mkdirSync(join(dir, 'node_modules', 'typescript'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version: withTypeScript }));
  }
  const result = spawnSync(process.execPath, [cli, 'typecheck', '--deploy', '--json'], { cwd: dir, encoding: 'utf8', env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, SOMEWHERE_CONFIG_DIR: join(base, 'config'),
    SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
  } });
  return { ...result, fetched: existsSync(join(base, 'npx-called')) };
}

test('typecheck --deploy with another TypeScript installed: names the pinned version and the project\'s, never "not installed"', { skip: process.platform === 'win32' }, () => {
  const result = runDeployCheck('5.9.3');
  assert.match(result.stderr, /The deploy check uses TypeScript [\d.]+, the version deploys check with; this project has 5\.9\.3, so typescript@[\d.]+ is fetched with npx/);
  assert.doesNotMatch(result.stderr, /not installed|dependencies are not/);
  assert.ok(JSON.parse(result.stdout), result.stdout);
  assert.ok(result.fetched);
});

test('typecheck --deploy with no TypeScript: says so, and stdout stays JSON', { skip: process.platform === 'win32' }, () => {
  const result = runDeployCheck(null);
  assert.match(result.stderr, /this project has no TypeScript installed, so typescript@[\d.]+ is fetched with npx \(needs the npm registry; npm keeps it in its cache\)/);
  assert.doesNotMatch(result.stderr, /dependencies are not installed/);
  assert.ok(JSON.parse(result.stdout), result.stdout);
  assert.ok(result.fetched);
});
