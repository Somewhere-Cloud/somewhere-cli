import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoLeak, UserSession, waitForApp } from '../dist/testing.js';

test('direct sessions and Playwright use cookies for the linked origin only', async (t) => {
  const session = new UserSession('https://fixture.test', { storageState: {
    origins: [], cookies: [{ name: 'session', value: 'fixture', domain: 'fixture.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  } });
  const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://fixture.test/api/tasks');
    assert.equal(options.headers.get('Cookie'), 'session=fixture');
    assert.equal(options.redirect, 'error');
    return new Response('ok');
  });
  assert.equal(await (await session.request('/api/tasks')).text(), 'ok');
  assert.equal((await session.storageState()).cookies[0].value, 'fixture');
  await assert.rejects(session.request('https://outside.test'), /app origin/);
  assert.equal(mock.mock.callCount(), 1);
});

test('marker checks name the response without quoting it', async () => {
  const rows = [{ url: 'https://fixture.test/api/tasks?private=do-not-print', status: 200, contentType: 'application/json', body: 'fixture-private-marker' }];
  await assertNoLeak('absent-marker', rows);
  await assert.rejects(assertNoLeak('fixture-private-marker', rows), { message: 'Private test marker appeared in /api/tasks (HTTP 200).' });
});

test('ready waits for a settled signed-in marker', async () => {
  const page = { locator(selector) {
    assert.match(selector, /html\[data-sw-auth="signed-in"\]/);
    assert.doesNotMatch(selector, /checking/);
    return { async waitFor(options) { assert.deepEqual(options, { state: 'visible' }); } };
  } };
  await waitForApp(page, 'signed-in');
});

test('sessions prove hidden reads and writes with a positive control', async (t) => {
  const origin = 'https://fixture.test';
  const target = { origin, contractDigest: 'fixture-digest' };
  const stranger = new UserSession(origin, { target });
  const owner = new UserSession(origin, { target, storageState: {
    origins: [], cookies: [{ name: 'session', value: 'owner', domain: 'fixture.test' }],
  } });
  let changedAfterDelete = false;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const isOwner = options.headers.get('Cookie') === 'session=owner';
    if (url.pathname === '/api/notes/n1') {
      return Response.json({ ok: isOwner }, { status: isOwner ? 200 : 404 });
    }
    assert.equal(url.pathname, '/__sw/data');
    const { contract, table, operation, id } = JSON.parse(options.body);
    assert.equal(contract, 'fixture-digest');
    assert.equal(table, 'notes');
    calls.push([isOwner, operation]);
    if (operation === 'delete') {
      assert.equal(isOwner, false);
      return Response.json({ error: 'DATA_NOT_FOUND' }, { status: 404 });
    }
    if (id === 'stale') return Response.json({ error: 'DATA_CONTRACT_MISMATCH' }, { status: 409 });
    return Response.json({ data: isOwner && id === 'n1' ? { id, changed: changedAfterDelete && calls.length > 2 } : null });
  });

  const withOwner = { allowed: owner };
  await stranger.expectRefused('notes', { operation: 'get', id: 'n1' }, withOwner);
  await stranger.expectRefused('notes', { operation: 'get', id: 'n1' }, { allowed: { session: owner } });
  await assert.rejects(stranger.expectRefused('notes', { operation: 'get', id: 'missing' }, withOwner), /nothing to refuse/);
  await assert.rejects(stranger.expectRefused('notes', { operation: 'get', id: 'n1' }), /proves nothing/);
  await assert.rejects(stranger.expectRefused('notes', { operation: 'get', id: 'stale' }, withOwner), /stale data contract/);
  await stranger.expectRefused('GET /api/notes/n1', undefined, withOwner);
  await assert.rejects(stranger.expectRefused('GET /api/notes/n1'), /proves nothing/);

  calls.length = 0;
  await stranger.expectRefused('notes', { operation: 'delete', id: 'n1' }, withOwner);
  assert.deepEqual(calls, [[true, 'get'], [false, 'delete'], [true, 'get']]);

  calls.length = 0;
  changedAfterDelete = true;
  await assert.rejects(stranger.expectRefused('notes', { operation: 'delete', id: 'n1' }, withOwner), /changed for the allowed person/);
});
