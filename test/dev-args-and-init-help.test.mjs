import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_SKILLS_PACK } from '../dist/lib/skills-pack.generated.js';
import { skillNames } from '../dist/lib/skills-pack.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
function run(args) {
  const cwd = mkdtempSync(join(tmpdir(), 'sw-dev-args-'));
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, SOMEWHERE_CONFIG_DIR: join(cwd, 'config'), SOMEWHERE_API_URL: 'http://127.0.0.1:9/v1',
    SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
  } });
}

// dev is frontend hot reload only; it runs no command of the caller's.
for (const args of [['dev', 'echo', 'hello'], ['dev', '--', 'npm', 'run', 'dev']]) {
  test(`\`${args.join(' ')}\` is refused instead of silently ignored`, () => {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /too many arguments for 'dev'/);
  });
}

test('dev with its own options still parses (and stops at the missing project link)', () => {
  const result = run(['dev', '--port', '3000']);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /too many arguments|unknown option/);
});

test('init --help names the number of skills it actually installs', () => {
  const count = skillNames(BUNDLED_SKILLS_PACK).length;
  assert.ok(count > 0);
  assert.match(run(['init', '--help']).stdout, new RegExp(`also install ${count} agent skills`));
});
