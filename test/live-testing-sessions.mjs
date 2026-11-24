// Run from a linked swtest app with a private client-readable table.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { request } from '@playwright/test';
import { data, openTestApp } from '../dist/testing.js';
import { loadProjectConfig } from '../dist/lib/config.js';

assert.match(loadProjectConfig()?.subdomain ?? '', /^swtest-/);
const table = process.argv[2];
assert.ok(table, 'Name a private client-readable table in the fixture.');
const app = await openTestApp();
let browser;
try {
  const [nodeActor, browserActor] = await app.users(2);
  const state = await browserActor.session.storageState();
  browser = await request.newContext({ storageState: state });
  assert.equal((await nodeActor.session.request('/api/auth/me')).status, 200);
  assert.equal((await data(browser, table, { operation: 'list' })).status(), 200);
  await setTimeout(62_000);
  // These operations share the same expiring session and must rotate it only once.
  const [me, directData, snapshot, playwrightData] = await Promise.all([
    nodeActor.session.request('/api/auth/me'),
    nodeActor.session.data(table, { operation: 'list' }),
    nodeActor.session.storageState(),
    data(browser, table, { operation: 'list' }),
  ]);
  assert.deepEqual([me.status, directData.status, playwrightData.status()], [200, 200, 200]);
  assert.equal((await me.json()).user.id, nodeActor.id);
  const fresh = await request.newContext({ storageState: snapshot });
  try {
    const me = await fresh.get(app.origin + '/api/auth/me');
    assert.equal(me.status(), 200);
    assert.equal((await me.json()).user.id, nodeActor.id);
  } finally {
    await fresh.dispose();
  }
  console.log('Node, data, and Playwright sessions all returned 200 after 62 seconds.');
} finally {
  await browser?.dispose();
  await app.cleanup();
}
