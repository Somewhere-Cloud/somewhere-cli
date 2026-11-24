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
  assert.equal(session.storageState().cookies[0].value, 'fixture');
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
