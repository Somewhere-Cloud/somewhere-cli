import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createUser, expectRefusal, waitForApp } from '@somewhere-cloud/cli/testing';

test('public helper keeps a user cookie and Origin; malformed requests cannot pass as refusals', async () => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    calls.push({ path: req.url, origin: req.headers.origin, cookie: req.headers.cookie, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/signup') {
      res.setHeader('Set-Cookie', '__Host-sw=fixture-session; Secure; HttpOnly; Path=/');
      res.end(JSON.stringify({ cookie_session: true }));
    } else res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const user = await createUser(origin);
    await user.data('notes', 'deployed-contract', { operation: 'list', limit: 1 });
    assert.equal(calls[0].origin, origin);
    assert.match(calls[1].cookie, /__Host-sw=fixture-session/);
    assert.equal(calls[1].origin, origin);
    assert.deepEqual(calls[1].body, { table: 'notes', contract: 'deployed-contract', operation: 'list', limit: 1 });
    await expectRefusal(Response.json({ error: 'DATA_ACCESS_DENIED' }, { status: 403 }), 403, 'DATA_ACCESS_DENIED');
    await assert.rejects(expectRefusal(Response.json({ error: 'DATA_OPERATION_INVALID' }, { status: 400 }), 403, 'DATA_ACCESS_DENIED'), /received 400/);
    await assert.rejects(expectRefusal(Response.json({ error: 'CSRF_FAILED' }, { status: 403 }), 403, 'DATA_ACCESS_DENIED'), /exact expected error code/);
    await assert.rejects(user.request('https://other.example/'), /stay on the app origin/);
    let selector;
    await waitForApp({ locator(value) { selector = value; return { async waitFor() {} }; } }, 'signed-out');
    assert.equal(selector, '[data-app-state="signed-out"]');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
