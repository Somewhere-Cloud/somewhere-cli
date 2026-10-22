import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { keepKey, readKeep, writeKeep, dropKeep, reusableIdentities, KEEP_IDENTITY_REUSE_MS } = await import('../dist/lib/verify-keep.js');

test('keepKey is stable for the same project and cast, and changes with either', () => {
  const cast = { alice: { test_user: true }, bob: { test_user: true } };
  assert.equal(keepKey('p1', cast), keepKey('p1', { bob: { test_user: true }, alice: { test_user: true } }), 'order does not matter');
  assert.notEqual(keepKey('p1', cast), keepKey('p2', cast));
  assert.notEqual(keepKey('p1', cast), keepKey('p1', { alice: { test_user: true }, bob: {} }), 'how an actor signs in is part of the key');
});

test('the record is private, holds ids/emails only, and identities are reused only inside 23 h', () => {
  const root = mkdtempSync(join(tmpdir(), 'keep-'));
  const now = Date.now();
  writeKeep(root, 'k', { project_id: 'p', created_at: new Date(now).toISOString(), actors: ['alice'], sessions: { alice: 'vf-kk-alice' }, identities: { alice: { user_id: 'u', email: 'a@t.test' } } });
  const file = join(root, '.somewhere', 'test', 'verify-actors.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!/token|cookie|password/i.test(readFileSync(file, 'utf-8')));
  assert.ok(readFileSync(join(root, '.gitignore'), 'utf-8').includes('.somewhere/test/'));
  const entry = readKeep(root, 'k');
  assert.deepEqual(reusableIdentities(entry, now + 1000), { alice: { user_id: 'u', email: 'a@t.test' } });
  assert.equal(reusableIdentities(entry, now + KEEP_IDENTITY_REUSE_MS + 1), undefined);
  dropKeep(root, 'k');
  assert.equal(readKeep(root, 'k'), null);
});
