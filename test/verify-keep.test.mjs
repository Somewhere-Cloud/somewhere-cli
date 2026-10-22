import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { keepKey, folderSalt, readKeep, writeKeep, dropKeep, listKeep, reusableIdentities, lockKeep, recordAfterRun, KEEP_IDENTITY_REUSE_MS } = await import('../dist/lib/verify-keep.js');

test('keepKey binds folder salt, project, flow file and the full cast (values hashed), and ignores key order', () => {
  const cast = { alice: { test_user: true }, bob: { auth: { user_id: 'u1' } } };
  const k = keepKey('s1', 'p1', '/f.json', cast);
  assert.equal(k, keepKey('s1', 'p1', '/f.json', { bob: { auth: { user_id: 'u1' } }, alice: { test_user: true } }));
  assert.notEqual(k, keepKey('s2', 'p1', '/f.json', cast), 'another folder never shares kept browsers');
  assert.notEqual(k, keepKey('s1', 'p2', '/f.json', cast));
  assert.notEqual(k, keepKey('s1', 'p1', '/g.json', cast), 'another flow file never shares them');
  assert.notEqual(k, keepKey('s1', 'p1', '/f.json', { alice: { test_user: true }, bob: { auth: { user_id: 'u2' } } }), 'a different user to sign in as is a different key');
});

test('the record is private, folder-salted, holds ids/emails only, and identities are reused only inside 23 h', () => {
  const root = mkdtempSync(join(tmpdir(), 'keep-'));
  const salt = folderSalt(root);
  assert.equal(folderSalt(root), salt, 'the salt is stable for the folder');
  assert.notEqual(folderSalt(mkdtempSync(join(tmpdir(), 'keep-'))), salt);
  const now = Date.now();
  writeKeep(root, 'k', { project_id: 'p', created_at: new Date(now).toISOString(), actors: ['alice'], sessions: { alice: 'vf-kk-alice' }, identities: { alice: { user_id: 'u', email: 'a@t.test' } } });
  const file = join(root, '.somewhere', 'test', 'verify-actors.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!/token|cookie|password/i.test(readFileSync(file, 'utf-8')));
  assert.ok(readFileSync(join(root, '.gitignore'), 'utf-8').includes('.somewhere/test/'));
  assert.deepEqual(listKeep(root, 'p').map(([key]) => key), ['k']);
  assert.deepEqual(listKeep(root, 'other'), []);
  const entry = readKeep(root, 'k');
  assert.deepEqual(reusableIdentities(entry, now + 1000), { alice: { user_id: 'u', email: 'a@t.test' } });
  assert.equal(reusableIdentities(entry, now + KEEP_IDENTITY_REUSE_MS + 1), undefined);
  dropKeep(root, 'k');
  assert.equal(readKeep(root, 'k'), null);
  assert.equal(folderSalt(root), salt, 'dropping an entry keeps the salt');
});

test('one run per kept flow: a live lock refuses a second run; a dead process lock is taken over', () => {
  const root = mkdtempSync(join(tmpdir(), 'keep-'));
  const release = lockKeep(root, 'k');
  assert.throws(() => lockKeep(root, 'k'), /in progress/);
  release();
  const again = lockKeep(root, 'k'); again();
  writeFileSync(join(root, '.somewhere', 'test', 'verify-actors-k.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  const takeover = lockKeep(root, 'k'); takeover();
});

test('the record: write what a passed run kept; keep the old record when cleanup is unconfirmed; drop it otherwise', () => {
  const prev = { project_id: 'p', created_at: '2026-10-21T00:00:00.000Z', actors: ['alice'], sessions: { alice: 's' }, identities: { alice: { user_id: 'u', email: 'e' } } };
  const kept = recordAfterRun(prev, { keep_actors: { kept: ['alice'], reused_identities: true }, kept_sessions: [{ actor: 'alice', session_id: 's' }], cleanup: [{ status: 'kept_open' }], test_users: { identities: [{ actor: 'alice', user_id: 'u', email: 'e' }], cleanup: { status: 'kept' } } }, 'p', Date.now());
  assert.equal(kept.action, 'write'); assert.equal(kept.entry.created_at, prev.created_at, 'reused identities keep their creation time');
  assert.deepEqual(recordAfterRun(prev, { keep_actors: { kept: [], reused_identities: true }, kept_sessions: [], cleanup: [{ status: 'unconfirmed' }], test_users: { identities: [], cleanup: { status: 'deleted' } } }, 'p', 0), { action: 'keep' });
  assert.deepEqual(recordAfterRun(prev, { keep_actors: { kept: [], reused_identities: true }, kept_sessions: [], cleanup: [{ status: 'closed' }], test_users: { identities: [], cleanup: { status: 'unconfirmed' } } }, 'p', 0), { action: 'keep' });
  assert.deepEqual(recordAfterRun(prev, { keep_actors: { kept: [], reused_identities: true }, kept_sessions: [], cleanup: [{ status: 'closed' }], test_users: { identities: [], cleanup: { status: 'deleted' } } }, 'p', 0), { action: 'drop' });
});
