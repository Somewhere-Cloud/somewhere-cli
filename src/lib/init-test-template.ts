import type { InitScaffoldFile } from './init-scaffold.js';

const session = `import { test, expect, data, expectRefused, ready } from '@somewhere-cloud/cli/testing';

test('session and sign-out', async ({ newUser }) => {
  const user = await newUser();
  const me = await user.request.get('/api/auth/me');
  expect(me.status()).toBe(200);
  expect((await me.json()).user.id).toBe(user.id);
  await user.page.goto('/');
  await ready(user.page, 'signed-in');
  expect((await user.request.post('/api/auth/logout', { data: {} })).status()).toBe(200);
  expect((await (await user.request.get('/api/auth/me')).json()).user).toBeNull();
  await user.page.reload();
  await ready(user.page, 'signed-out');
});
`;
const closed = `
test('browser data is closed', async ({ anonymous }) => {
  await expectRefused(await data(anonymous, 'notes', { operation: 'list' }), 403, 'DATA_ACCESS_DENIED');
});
`;
const isolation = `
test('owners can read only their own notes', async ({ newUser }) => {
  const owner = await newUser();
  const outsider = await newUser();
  const title = 'isolation-' + crypto.randomUUID();
  const created = await data(owner.request, 'notes', { operation: 'create', values: { title, body: 'test row' } });
  expect(created.status()).toBe(200);
  const row = (await created.json()).data as { id: number; title: string };
  expect(row.title).toBe(title);
  const own = await data(owner.request, 'notes', { operation: 'get', id: row.id });
  expect(own.status()).toBe(200);
  expect((await own.json()).data.title).toBe(title);
  const updatedTitle = title + '-owner';
  const updated = await data(owner.request, 'notes', { operation: 'update', id: row.id, values: { title: updatedTitle } });
  expect(updated.status()).toBe(200);
  expect((await (await data(owner.request, 'notes', { operation: 'get', id: row.id })).json()).data.title).toBe(updatedTitle);
  const list = await data(outsider.request, 'notes', { operation: 'list', where: { title: updatedTitle } });
  expect(list.status()).toBe(200);
  expect((await list.json()).data, 'another user must not see the owner row').toEqual([]);
  // Hidden rows read as not there (200, data null); prove absence and a refused write.
  const hidden = await data(outsider.request, 'notes', { operation: 'get', id: row.id });
  expect(hidden.status()).toBe(200);
  expect((await hidden.json()).data).toBeNull();
  await expectRefused(await data(outsider.request, 'notes', { operation: 'update', id: row.id, values: { title: 'changed' } }), 404, 'DATA_NOT_FOUND');
  const unchanged = await data(owner.request, 'notes', { operation: 'get', id: row.id });
  expect(unchanged.status()).toBe(200);
  expect((await unchanged.json()).data.title).toBe(updatedTitle);
});
`;
export function starterTests(privateData = false): InitScaffoldFile[] {
  return [{ path: 'tests/app.spec.ts', content: session + (privateData ? isolation : closed) }];
}
