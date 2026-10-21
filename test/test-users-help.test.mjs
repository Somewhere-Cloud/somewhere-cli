// `somewhere test-users prepare --help` points at the real session expiry the
// command prints and records, and promises no fixed duration (tsk_70d6db11):
// 0.37.63 said "about 1 hour" and "24 hours", which the platform does not guarantee.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test('prepare --help names session_expires_at and cleanup, and states no fixed duration', () => {
  const help = execFileSync(process.execPath, [cli, 'test-users', 'prepare', '--help'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.match(help, /session_expires_at/);
  assert.match(help, /somewhere test-users cleanup/);
  assert.doesNotMatch(help, /\b1 hour\b|\bone hour\b|\b24 hours?\b|\b24 ?h\b/i);
});
