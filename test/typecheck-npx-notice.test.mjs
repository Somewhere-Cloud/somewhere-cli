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

test('typecheck --deploy --json announces the npx fetch on stderr and keeps stdout JSON', { skip: process.platform === 'win32' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'sw-npx-notice-'));
  const dir = join(base, 'app'), bin = join(base, 'bin');
  mkdirSync(join(dir, 'api'), { recursive: true }); mkdirSync(bin);
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho called > "${join(base, 'npx-called')}"\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'api/hello.ts'), 'export default async () => new Response("hi");\n');
  const result = spawnSync(process.execPath, [cli, 'typecheck', '--deploy', '--json'], { cwd: dir, encoding: 'utf8', env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, SOMEWHERE_CONFIG_DIR: join(base, 'config'),
    SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
  } });
  assert.match(result.stderr, /fetching typescript@[\d.]+ with npx \(needs the npm registry; npm keeps it in its cache\)/);
  assert.ok(JSON.parse(result.stdout), result.stdout);
  assert.ok(existsSync(join(base, 'npx-called')), 'the announced fetch is the one that ran');
});
