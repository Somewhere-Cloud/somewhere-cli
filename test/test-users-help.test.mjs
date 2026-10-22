// `somewhere test-users prepare --help` names the initial (minted) expiry the
// command prints, says a refresh with saved-back state can renew it, and points at
// cleanup; it promises no fixed duration and no end time (tsk_70d6db11). 0.37.63
// said "about 1 hour" and "24 hours", which the platform does not guarantee.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test('prepare --help names the initial expiry, renewal and cleanup, and states no fixed duration or end time', () => {
  const help = execFileSync(process.execPath, [cli, 'test-users', 'prepare', '--help'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.match(help, /session_expires_at/);
  assert.match(help, /somewhere test-users cleanup/);
  assert.match(help, /refresh during a run can renew it/);
  assert.match(help, /do not rely on expiry to end access/);
  assert.doesNotMatch(help, /\b1 hour\b|\bone hour\b|\b24 hours?\b|\b24 ?h\b/i);
  assert.doesNotMatch(help, /session ends at/i, 'the printed time is the minted expiry, not when a saved-back state stops working');
});
