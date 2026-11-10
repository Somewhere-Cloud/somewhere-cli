import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// The local MCP bridge (`somewhere mcp`) in recovery mode (tsk_224b77a0): with no login, or when the
// platform refuses the login or the CLI version, it answers initialize and tools/list itself with ONE
// status tool, returns an actionable error from it, stays alive, picks up a login made outside it
// without replaying any earlier request, and reports transport failures with their real reason.
const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const STATUS_TOOL = 'somewhere_status';
const UPDATE_MESSAGE = 'This version of the Somewhere CLI is out of date. Update with: npm i -g @somewhere-cloud/cli@latest, then run somewhere login.';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
const url = (server, path) => `http://127.0.0.1:${server.address().port}${path}`;

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-mcp-recovery-'));
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  return dir;
}
function login(dir, token) {
  writeFileSync(join(dir, '.somewhere', 'config.json'), JSON.stringify({ token, user: { email: 'recovery@example.test', username: '' } }) + '\n');
}

/** A stateless upstream MCP server that records every JSON-RPC request it receives. */
function upstream({ refuse } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const rpc = body ? JSON.parse(body) : {};
      received.push({ method: rpc.method, name: rpc.params?.name, authorization: req.headers.authorization, headers: req.headers });
      const refusal = refuse?.(req, rpc);
      res.setHeader('Content-Type', 'application/json');
      if (refusal) {
        res.statusCode = refusal.status;
        res.end(JSON.stringify(refusal.body));
        return;
      }
      if (rpc.id === undefined) { res.statusCode = 202; res.end(); return; }
      const result = rpc.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'upstream-test', version: '1.0.0' } }
        : rpc.method === 'tools/list' ? { tools: [{ name: 'project_list', inputSchema: { type: 'object' } }, { name: 'project_delete', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'ran' }] };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
  });
  return { server, received };
}

/** The REST API, for the bridge's renewal check (GET /auth/whoami). */
function api(answer) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const { status, body } = answer(req);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return server;
}

function bridge(dir, mcpUrl, apiUrl) {
  const child = spawn(process.execPath, [distIndex, 'mcp'], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, SOMEWHERE_CONFIG_DIR: '', SOMEWHERE_MCP_URL: mcpUrl, SOMEWHERE_API_URL: apiUrl, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const queue = [];
  const waiters = [];
  let stderr = '';
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); } else queue.push(message);
  });
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const next = (predicate, timeoutMs = 8_000) => {
    const queued = queue.findIndex(predicate);
    if (queued >= 0) return Promise.resolve(queue.splice(queued, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`no MCP message; stderr=${stderr}`)); }, timeoutMs) };
      waiters.push(waiter);
    });
  };
  let id = 0;
  return {
    child,
    stderr: () => stderr,
    notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
    request(method, params = {}) {
      const rid = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
      return next((message) => message.id === rid);
    },
    next,
  };
}

const initialize = (b) => b.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'recovery-test', version: '1' } });

test('no login: initialize and tools/list complete locally with one status tool, which returns the actionable error; the bridge stays up', async () => {
  const up = upstream();
  await listen(up.server);
  const dir = home();
  const b = bridge(dir, url(up.server, '/mcp'), 'http://127.0.0.1:9/v1');
  try {
    const init = await initialize(b);
    assert.equal(init.error, undefined, JSON.stringify(init));
    assert.equal(init.result.serverInfo.name, 'somewhere');
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.result.capabilities.tools, { listChanged: true });
    assert.match(init.result.instructions, /somewhere login/);
    b.notify('notifications/initialized');

    const list = await b.request('tools/list');
    assert.deepEqual(list.result.tools.map((tool) => tool.name), [STATUS_TOOL], 'exactly one diagnostic tool, never a copy of the remote catalog');

    const status = await b.request('tools/call', { name: STATUS_TOOL, arguments: {} });
    assert.equal(status.result.isError, true);
    assert.match(status.result.content[0].text, /NOT_LOGGED_IN/);
    assert.match(status.result.content[0].text, /Run `somewhere login` in a terminal/);

    const other = await b.request('tools/call', { name: 'project_delete', arguments: { project: 'p' } });
    assert.equal(other.result.isError, true);
    assert.match(other.result.content[0].text, /will not send it later/);

    assert.deepEqual(await b.request('ping'), { jsonrpc: '2.0', id: 5, result: {} });
    assert.equal(b.child.exitCode, null, 'bridge stays alive');
    assert.equal(up.received.length, 0, 'nothing reaches the platform without a login');
  } finally {
    b.child.kill('SIGTERM');
    await close(up.server);
  }
});

test('a login made outside the bridge is picked up on the next status call, the tool list is announced as changed, and nothing earlier is replayed', async () => {
  const up = upstream();
  await listen(up.server);
  const dir = home();
  const b = bridge(dir, url(up.server, '/mcp'), 'http://127.0.0.1:9/v1');
  try {
    await initialize(b);
    b.notify('notifications/initialized');
    const refused = await b.request('tools/call', { name: 'project_delete', arguments: { project: 'p' } });
    assert.equal(refused.result.isError, true);

    login(dir, 'smt_fresh_login');
    const status = await b.request('tools/call', { name: STATUS_TOOL, arguments: {} });
    assert.equal(status.result.isError, undefined, JSON.stringify(status));
    assert.match(status.result.content[0].text, /connected/);
    await b.next((message) => message.method === 'notifications/tools/list_changed');

    const list = await b.request('tools/list');
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ['project_list', 'project_delete']);
    assert.ok(up.received.every((call) => call.authorization === 'Bearer smt_fresh_login'));
    assert.deepEqual(up.received.filter((call) => call.method === 'tools/call'), [], 'the refused project_delete is never sent');
    assert.equal(b.child.exitCode, null);
  } finally {
    b.child.kill('SIGTERM');
    await close(up.server);
  }
});

test('a login the platform refuses mid-session: the mutation that hit the refusal is not replayed after re-login', async () => {
  const up = upstream({
    refuse: (req) => req.headers.authorization === 'Bearer smt_revoked'
      ? { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Session revoked' } } }
      : null,
  });
  const rest = api(() => ({ status: 401, body: { ok: false, error: 'SESSION_REVOKED', message: 'This device session was revoked from the dashboard.' } }));
  await Promise.all([listen(up.server), listen(rest)]);
  const dir = home();
  login(dir, 'smt_revoked');
  const b = bridge(dir, url(up.server, '/mcp'), url(rest, '/v1'));
  try {
    const call = await b.request('tools/call', { name: 'project_delete', arguments: { project: 'p' } });
    assert.equal(call.result.isError, true, JSON.stringify(call));
    assert.match(call.result.content[0].text, /SESSION_REVOKED: This device session was revoked from the dashboard\./);
    assert.match(call.result.content[0].text, /will not send it later/);
    const sentBefore = up.received.filter((r) => r.name === 'project_delete').length;
    assert.ok(sentBefore >= 1 && sentBefore <= 2, `refused attempts: ${sentBefore}`);

    const list = await b.request('tools/list');
    assert.deepEqual(list.result.tools.map((tool) => tool.name), [STATUS_TOOL]);

    login(dir, 'smt_fresh_login');
    const status = await b.request('tools/call', { name: STATUS_TOOL, arguments: {} });
    assert.equal(status.result.isError, undefined, JSON.stringify(status));
    const listed = await b.request('tools/list');
    assert.equal(listed.result.tools.length, 2);
    assert.equal(up.received.filter((r) => r.name === 'project_delete').length, sentBefore, 'no replay after re-login');
    assert.equal(up.received.filter((r) => r.authorization === 'Bearer smt_fresh_login' && r.method === 'tools/call').length, 0);
    assert.doesNotMatch(b.stderr(), /smt_revoked|smt_fresh_login/, 'no credential in diagnostics');
    assert.equal(b.child.exitCode, null);
  } finally {
    b.child.kill('SIGTERM');
    await Promise.all([close(up.server), close(rest)]);
  }
});

test('an out-of-date client refusal from the MCP host: initialize completes locally and the status tool gives the update command', async () => {
  const up = upstream({
    refuse: () => ({ status: 410, body: { jsonrpc: '2.0', id: null, error: { code: -32000, message: UPDATE_MESSAGE, data: { error: 'CLIENT_UPDATE_REQUIRED' } } } }),
  });
  await listen(up.server);
  const dir = home();
  login(dir, 'smt_valid');
  const b = bridge(dir, url(up.server, '/mcp'), 'http://127.0.0.1:9/v1');
  try {
    const init = await initialize(b);
    assert.equal(init.result.serverInfo.name, 'somewhere', JSON.stringify(init));
    assert.match(init.result.instructions, /CLIENT_UPDATE_REQUIRED/);
    const list = await b.request('tools/list');
    assert.deepEqual(list.result.tools.map((tool) => tool.name), [STATUS_TOOL]);
    const status = await b.request('tools/call', { name: STATUS_TOOL, arguments: {} });
    assert.equal(status.result.isError, true);
    assert.match(status.result.content[0].text, /npm i -g @somewhere-cloud\/cli@latest/);
    assert.match(status.result.content[0].text, /restart this MCP session/);
    assert.equal(b.child.exitCode, null);
  } finally {
    b.child.kill('SIGTERM');
    await close(up.server);
  }
});

test('a transport failure is reported with its real reason and the bridge keeps serving', async () => {
  const dead = createServer();
  await listen(dead);
  const deadUrl = url(dead, '/mcp');
  await close(dead); // nothing listens there now: connection refused
  const dir = home();
  login(dir, 'smt_valid');
  const b = bridge(dir, deadUrl, 'http://127.0.0.1:9/v1');
  try {
    const init = await initialize(b);
    assert.ok(init.error, JSON.stringify(init));
    assert.match(init.error.message, /Could not reach http:\/\/127\.0\.0\.1:\d+\/mcp: .*ECONNREFUSED/);
    assert.doesNotMatch(init.error.message, /session could not be renewed|somewhere login/);
    const again = await b.request('tools/list');
    assert.match(again.error.message, /ECONNREFUSED/);
    assert.equal(b.child.exitCode, null, 'a network failure does not end the session');
  } finally {
    b.child.kill('SIGTERM');
  }
});

test('a valid login (a CI developer key with no refresh token or version header) is forwarded unchanged, with no recovery', async () => {
  const up = upstream();
  await listen(up.server);
  const dir = home();
  login(dir, 'smt_ci_developer_key');
  const b = bridge(dir, url(up.server, '/mcp'), 'http://127.0.0.1:9/v1');
  try {
    const init = await initialize(b);
    assert.equal(init.result.serverInfo.name, 'upstream-test');
    assert.equal(init.result.capabilities.tools.listChanged, true, 'the bridge can deliver list_changed, so it declares it');
    const list = await b.request('tools/list');
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ['project_list', 'project_delete']);
    const run = await b.request('tools/call', { name: 'project_list', arguments: {} });
    assert.equal(run.result.content[0].text, 'ran');
    assert.equal(up.received.filter((r) => r.method === 'tools/call').length, 1);
    for (const { headers } of up.received) {
      assert.deepEqual(Object.keys(headers).filter((name) => /version/i.test(name) && name !== 'mcp-protocol-version'), [], 'no client version header');
    }
  } finally {
    b.child.kill('SIGTERM');
    await close(up.server);
  }
});
