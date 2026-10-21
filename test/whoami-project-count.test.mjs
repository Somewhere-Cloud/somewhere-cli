import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProjectCount } from '../dist/commands/auth.js';

// tsk_8a68dfa2: whoami counted 6 projects while `somewhere projects` listed 5. whoami's number is
// every owned project in any status; the list adds shared/group projects and leaves out archived
// and being-deleted ones. whoami now says which is which so the two numbers reconcile.
const stub = (allRows, archivedRows, fail = false) => ({
  async call(method, path, body, query) {
    if (fail) throw new Error('unavailable');
    assert.equal(method, 'GET'); assert.equal(path, '/projects');
    return { projects: query.archived === 'only' ? archivedRows : allRows };
  },
});
const own = (status) => ({ status, is_owner: true });
const shared = (status = 'deployed') => ({ status, is_owner: false });

test('a plain account reads as owned projects only', async () => {
  assert.equal(await describeProjectCount(stub([own('deployed'), own('draft')], []), 2), '2 projects you own');
});

test('the founder case: 6 owned, one archived, so the list shows 5', async () => {
  const text = await describeProjectCount(stub([own('deployed'), own('deployed'), own('deployed'), own('deployed'), own('draft')], [own('archived')]), 6);
  assert.equal(text, '6 projects you own (`somewhere projects` lists 5 of them; not listed: 1 archived)');
});

test('shared projects add to the list, deleting ones leave it, and the arithmetic matches the list', async () => {
  const all = [own('deployed'), own('deployed'), own('deleting'), own('delete_failed'), shared(), shared(), shared('deleting')];
  const text = await describeProjectCount(stub(all, [own('archived'), shared('archived')]), 5);
  assert.equal(text, '5 projects you own (`somewhere projects` lists 2 of them plus 2 shared with you; not listed: 1 archived, 2 being deleted)');
});

test('a failed breakdown read never fails whoami: the count is still labelled', async () => {
  assert.equal(await describeProjectCount(stub([], [], true), 6), '6 projects you own (any status)');
});
