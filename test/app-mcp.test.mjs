import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// somewhere app login/tools/call/logout against a local app and issuer. The
// fake issuer behaves like the platform's app MCP OAuth server; "the browser"
// is this test following the printed authorize address.
const cliBin = fileURLToPath(new URL('../bin/somewhere.js', import.meta.url));
const DEV_KEY = 'smt_developer_key_never_sent_to_an_app';

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b)); });
const b64url = (buf) => buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function world() {
  const log = []; // every request any server saw: { server, method, path, auth, origin, body }
  const state = { clients: new Map(), codes: new Map(), access: new Map(), refresh: new Map(), seq: 0,
    rejectAccess: false, refreshStatus: 200, revokeStatus: 200, used: new Set(), reuseRevocations: 0, tokenDelayMs: 0, echoToken: false, tools: [{ name: 'add_note', description: 'Add a note', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
  const token = (prefix) => `${prefix}${String(++state.seq).padStart(43, 'x')}`;
  const record = async (server, req) => {
    const body = await readBody(req);
    log.push({ server, method: req.method, path: req.url, auth: req.headers.authorization ?? null, origin: req.headers.origin ?? null, body });
    return body;
  };
  const api = await listen(async (req, res) => {
    const body = await record('api', req);
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/v1\/app-mcp\/([^/]+)\/(register|authorize|token|revoke)$/);
    if (!m) { res.writeHead(404).end(); return; }
    const issuer = `http://127.0.0.1:${api.address().port}/v1/app-mcp/${m[1]}`;
    if (m[2] === 'register') {
      const meta = JSON.parse(body);
      const id = `sam_c_${++state.seq}`;
      state.clients.set(id, meta.redirect_uris);
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ client_id: id }));
    } else if (m[2] === 'authorize') {
      const p = url.searchParams;
      assert.ok(state.clients.get(p.get('client_id'))?.includes(p.get('redirect_uri')), 'redirect registered');
      const code = b64url(Buffer.alloc(32, ++state.seq));
      state.codes.set(code, { challenge: p.get('code_challenge'), client: p.get('client_id'), redirect: p.get('redirect_uri') });
      const back = new URL(p.get('redirect_uri'));
      if (state.deny) back.searchParams.set('error', 'access_denied');
      else back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state'));
      back.searchParams.set('iss', issuer);
      res.writeHead(302, { location: back.toString() }).end();
    } else if (m[2] === 'token') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        const pending = state.codes.get(p.get('code'));
        const challenge = b64url(createHash('sha256').update(p.get('code_verifier') ?? '').digest());
        if (!pending || pending.challenge !== challenge || pending.client !== p.get('client_id') || pending.redirect !== p.get('redirect_uri')) {
          res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_grant"}');
          return;
        }
      } else {
        // Like the platform issuer: a refresh token is single-use, and presenting a
        // used one revokes the whole grant (every token of this project here).
        await new Promise((r) => setTimeout(r, state.tokenDelayMs));
        const presented = p.get('refresh_token');
        if (state.used.has(presented)) {
          state.reuseRevocations++;
          for (const map of [state.access, state.refresh]) for (const [k, v] of map) if (v === m[1]) map.delete(k);
        }
        if (state.refreshStatus !== 200 || !state.refresh.has(presented)) {
          res.writeHead(state.refreshStatus === 200 ? 400 : state.refreshStatus, { 'content-type': 'application/json' }).end('{"error":"invalid_grant"}');
          return;
        }
        state.refresh.delete(presented);
        state.used.add(presented);
      }
      const access = token('sam_a_'), refresh = token('sam_r_');
      state.access.set(access, m[1]);
      state.refresh.set(refresh, m[1]);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 }));
    } else {
      res.writeHead(state.revokeStatus).end();
    }
  });
  const apiUrl = `http://127.0.0.1:${api.address().port}/v1`;
  const makeApp = async (name, projectId) => {
    const server = await listen(async (req, res) => {
      const body = await record(name, req);
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.url === '/.well-known/oauth-protected-resource/mcp') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [`${apiUrl}/app-mcp/${projectId}`] }));
        return;
      }
      if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (state.rejectAccess || state.access.get(bearer) !== projectId) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid_token"}');
        return;
      }
      const msg = JSON.parse(body);
      const reply = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...result }));
      if (msg.method === 'tools/list') return reply({ result: { tools: state.tools } });
      if (msg.method === 'tools/call') {
        if (!state.tools.some((t) => t.name === msg.params.name)) return reply({ error: { code: -32602, message: 'Tool unavailable or renewed consent required.' } });
        const saved = state.echoToken ? `${msg.params.arguments.text} ${bearer}` : msg.params.arguments.text;
        return reply({ result: { content: [{ type: 'text', text: JSON.stringify({ saved }) }], structuredContent: { saved } } });
      }
      reply({ error: { code: -32601, message: 'Method not found' } });
    });
    return { server, origin: `http://127.0.0.1:${server.address().port}` };
  };
  const appA = await makeApp('appA', 'proj_a');
  const appB = await makeApp('appB', 'proj_b');
  const root = mkdtempSync(join(tmpdir(), 'sw-app-mcp-'));
  const config = join(root, 'cfg');
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: DEV_KEY }), { mode: 0o600 });
  const env = { ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: apiUrl, SOMEWHERE_MCP_URL: `${apiUrl}/mcp-not-used`,
    SOMEWHERE_NO_BROWSER: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', NO_COLOR: '1', HOME: root };
  delete env.SSH_CONNECTION; delete env.SSH_TTY;
  const close = () => { api.close(); appA.server.close(); appB.server.close(); };
  return { log, state, appA, appB, config, env, close, root };
}

/** Run the CLI; when it prints an authorize address, act as the browser. */
function cli(w, args, { browser = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliBin, ...args], { cwd: w.root, env: w.env });
    let stdout = '', stderr = '', done = false;
    const onOut = async (chunk, which) => {
      if (which === 'out') stdout += chunk; else stderr += chunk;
      const m = (stdout + stderr).match(/(http:\/\/127\.0\.0\.1:\d+\/v1\/app-mcp\/\S+\/authorize\?\S+)/);
      if (browser && m && !done) {
        done = true;
        const r = await fetch(m[1], { redirect: 'manual' });
        await fetch(r.headers.get('location'));
      }
    };
    child.stdout.on('data', (d) => onOut(String(d), 'out'));
    child.stderr.on('data', (d) => onOut(String(d), 'err'));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const store = (w) => JSON.parse(readFileSync(join(w.config, 'app-mcp', 'tokens.json'), 'utf8'));

test('login stores 0600 tokens keyed by origin, tools and call are one POST each, no developer key reaches an app', async () => {
  const w = await world();
  try {
    const login = await cli(w, ['app', 'login', w.appA.origin]);
    assert.equal(login.status, 0, login.stderr + login.stdout);
    const path = join(w.config, 'app-mcp', 'tokens.json');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const entry = store(w).apps[w.appA.origin];
    assert.match(entry.access_token, /^sam_a_/);
    assert.match(entry.refresh_token, /^sam_r_/);
    assert.deepEqual(entry.redirect_uris, ['http://127.0.0.1:47623/callback', 'http://127.0.0.1:47624/callback']);
    assert.ok(!login.stdout.includes(entry.access_token) && !login.stdout.includes(entry.refresh_token), 'tokens never printed');
    // Sign-in from the terminal: discovery, register, token.
    const terminal = w.log.filter((r) => !r.path.includes('/authorize'));
    assert.deepEqual(terminal.map((r) => `${r.method} ${r.path.split('?')[0]}`), [
      'GET /.well-known/oauth-protected-resource/mcp', 'POST /v1/app-mcp/proj_a/register', 'POST /v1/app-mcp/proj_a/token']);

    w.log.length = 0;
    const tools = await cli(w, ['app', 'tools', w.appA.origin]);
    assert.equal(tools.status, 0, tools.stderr);
    assert.match(tools.stdout, /add_note/);
    assert.match(tools.stdout, /text \(string, required\)/);
    const call = await cli(w, ['app', 'call', w.appA.origin, 'add_note', '{"text":"hi"}']);
    assert.equal(call.status, 0, call.stderr);
    assert.deepEqual(JSON.parse(call.stdout), { saved: 'hi' });
    assert.deepEqual(w.log.map((r) => `${r.server} ${r.method} ${r.path}`), ['appA POST /mcp', 'appA POST /mcp']);
    assert.ok(w.log.every((r) => r.auth === `Bearer ${store(w).apps[w.appA.origin].access_token}` && r.origin === null));
  } finally { w.close(); }
  assert.ok(w.log.every((r) => !String(r.auth).includes(DEV_KEY) && !r.body.includes(DEV_KEY)), 'developer key never sent');
});

test('the fixed port is reused and no second client is registered; an app B never gets app A\'s token', async () => {
  const w = await world();
  try {
    assert.equal((await cli(w, ['app', 'login', w.appA.origin])).status, 0);
    const client = store(w).apps[w.appA.origin].client_id;
    const again = await cli(w, ['app', 'login', w.appA.origin, '--json']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).client_reused, true);
    assert.equal(store(w).apps[w.appA.origin].client_id, client);
    assert.equal(w.log.filter((r) => r.path.endsWith('/register')).length, 1);
    const ports = w.log.filter((r) => r.path.includes('/authorize')).map((r) => new URL(r.path, 'http://x').searchParams.get('redirect_uri'));
    assert.deepEqual(ports, ['http://127.0.0.1:47623/callback', 'http://127.0.0.1:47623/callback']);

    const b = await cli(w, ['app', 'tools', w.appB.origin]);
    assert.equal(b.status, 1);
    assert.match(b.stderr, /Not signed in to http:\/\/127\.0\.0\.1:\d+\. Run somewhere app login/);
    assert.equal(w.log.filter((r) => r.server === 'appB').length, 0, 'nothing sent to app B');
    // Not to the platform either: the only API calls were sign-in calls for proj_a.
    assert.ok(w.log.filter((r) => r.server === 'api').every((r) => r.path.startsWith('/v1/app-mcp/proj_a/')));
  } finally { w.close(); }
});

test('a 401 refreshes once and retries once; a second 401 says sign in again', async () => {
  const w = await world();
  try {
    assert.equal((await cli(w, ['app', 'login', w.appA.origin])).status, 0);
    // The access token stops working: one refresh, one retry, success.
    const first = store(w).apps[w.appA.origin].access_token;
    w.state.access.delete(first);
    w.log.length = 0;
    const ok = await cli(w, ['app', 'call', w.appA.origin, 'add_note', '{"text":"x"}']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(w.log.map((r) => `${r.method} ${r.path}`), ['POST /mcp', 'POST /v1/app-mcp/proj_a/token', 'POST /mcp']);

    // Signed out in the browser: the app refuses every token and refresh is refused.
    w.state.rejectAccess = true;
    w.state.refreshStatus = 401;
    w.log.length = 0;
    const ended = await cli(w, ['app', 'call', w.appA.origin, 'add_note', '{"text":"x"}']);
    assert.equal(ended.status, 1);
    assert.match(ended.stderr, /has ended.*Sign in again with somewhere app login http:\/\/127\.0\.0\.1:\d+/s);
    assert.deepEqual(w.log.map((r) => `${r.method} ${r.path}`), ['POST /mcp', 'POST /v1/app-mcp/proj_a/token']);
    assert.equal(store(w).apps[w.appA.origin].access_token, undefined, 'ended sign-in removed');
    assert.ok(store(w).apps[w.appA.origin].client_id, 'client kept for the next sign-in');

    // Refresh works but the app still refuses: exactly one refresh, one retry.
    assert.equal((await cli(w, ['app', 'login', w.appA.origin])).status, 0);
    w.state.refreshStatus = 200;
    w.log.length = 0;
    const twice = await cli(w, ['app', 'tools', w.appA.origin]);
    assert.equal(twice.status, 1);
    assert.match(twice.stderr, /Sign in again/);
    assert.deepEqual(w.log.map((r) => `${r.method} ${r.path}`), ['POST /mcp', 'POST /v1/app-mcp/proj_a/token', 'POST /mcp']);
  } finally { w.close(); }
});

test('logout revokes then removes; a refused revoke still removes and says so', async () => {
  const w = await world();
  try {
    assert.equal((await cli(w, ['app', 'login', w.appA.origin])).status, 0);
    const entry = store(w).apps[w.appA.origin];
    w.log.length = 0;
    const out = await cli(w, ['app', 'logout', w.appA.origin]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(w.log.length, 1);
    assert.equal(w.log[0].path, '/v1/app-mcp/proj_a/revoke');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(w.log[0].body)), { token: entry.refresh_token, client_id: entry.client_id });
    assert.deepEqual(Object.keys(store(w).apps[w.appA.origin]).sort(), ['client_id', 'issuer', 'redirect_uris']);

    assert.equal((await cli(w, ['app', 'login', w.appA.origin])).status, 0);
    w.state.revokeStatus = 503;
    const refused = await cli(w, ['app', 'logout', w.appA.origin]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Could not revoke the sign-in at the server \(HTTP 503\)/);
    assert.equal(store(w).apps[w.appA.origin].refresh_token, undefined);
  } finally { w.close(); }
});

test('failures say what failed: unknown tool, consent refused, no MCP, ports in use, redirect, no browser, https', async () => {
  const w = await world();
  try {
    assert.equal((await cli(w, ['app', 'login', w.appA.origin])).status, 0);
    const missing = await cli(w, ['app', 'call', w.appA.origin, 'nope', '{}']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no tool named "nope".*Tools: add_note/s);

    w.state.deny = true;
    const denied = await cli(w, ['app', 'login', w.appA.origin]);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /Access was refused on the consent page/);
    w.state.deny = false;

    const plain = await listen((req, res) => res.writeHead(404).end());
    const absent = await cli(w, ['app', 'login', `http://127.0.0.1:${plain.address().port}`]);
    plain.close();
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /has no app MCP server/);

    const redirecting = await listen((req, res) => res.writeHead(302, { location: 'https://elsewhere.example/x' }).end());
    const moved = await cli(w, ['app', 'login', `http://127.0.0.1:${redirecting.address().port}`]);
    redirecting.close();
    assert.match(moved.stderr, /redirect to https:\/\/elsewhere\.example\. It was not followed/);

    const busy = await Promise.all([47623, 47624].map((port) => new Promise((resolve) => { const s = createServer(); s.listen(port, '127.0.0.1', () => resolve(s)); })));
    const ports = await cli(w, ['app', 'login', w.appA.origin]);
    busy.forEach((s) => s.close());
    assert.equal(ports.status, 1);
    assert.match(ports.stderr, /Ports 47623 and 47624 on 127\.0\.0\.1 are both in use/);

    const ssh = await cli({ ...w, env: { ...w.env, SOMEWHERE_NO_BROWSER: '', SSH_CONNECTION: '1 2 3 4' } }, ['app', 'login', w.appA.origin]);
    assert.equal(ssh.status, 1);
    assert.match(ssh.stderr, /SSH session.*not supported/s);

    const api = new URL(w.env.SOMEWHERE_API_URL);
    for (const issuer of [`${api.href}/app-mcp/proj_a?x=1`, `${api.href}/app-mcp/proj_a/../other`, `${api.href}/app-mcp/a%2Fb`, 'https://evil.example/v1/app-mcp/proj_a']) {
      const odd = await listen((req, res) => res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ resource: `http://127.0.0.1:${odd.address().port}/mcp`, authorization_servers: [issuer] })));
      const refused = await cli(w, ['app', 'login', `http://127.0.0.1:${odd.address().port}`]);
      odd.close();
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /not a Somewhere app sign-in server/, issuer);
    }

    const http = await cli(w, ['app', 'tools', 'http://notes.example.com']);
    assert.match(http.stderr, /not https/);
  } finally { w.close(); }
});

test('the token file lives only in the CLI config directory', async () => {
  const w = await world();
  try {
    assert.equal((await cli(w, ['app', 'login', w.appA.origin])).status, 0);
    assert.equal(existsSync(join(w.root, 'app-mcp')), false);
    assert.equal(existsSync(join(w.root, '.somewhere.json')), false);
    assert.equal(JSON.parse(readFileSync(join(w.config, 'config.json'), 'utf8')).token, DEV_KEY, 'developer login untouched');
  } finally { w.close(); }
});

// Two commands at once (agents do this) must not both spend the single-use refresh token:
// the issuer would read the second as reuse and revoke the grant.
test('two concurrent calls with an expired token refresh once; both succeed and the grant survives', async () => {
  const w = await world();
  try {
    assert.equal((await cli(w, ['app', 'login', w.appA.origin])).status, 0);
    w.state.tokenDelayMs = 300; // keep the first refresh in flight while the second process arrives
    const path = join(w.config, 'app-mcp', 'tokens.json');
    const expire = () => {
      const s = store(w);
      s.apps[w.appA.origin].access_expires_at = Date.now() - 1000;
      writeFileSync(path, JSON.stringify(s), { mode: 0o600 });
    };
    // Expired by the clock: both processes would refresh before calling.
    expire();
    w.log.length = 0;
    const [a, b] = await Promise.all([1, 2].map((n) => cli(w, ['app', 'call', w.appA.origin, 'add_note', `{"text":"${n}"}`])));
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(w.log.filter((r) => r.path.endsWith('/token')).length, 1, 'one refresh');
    assert.equal(w.state.reuseRevocations, 0);

    // Refused by the app (401) while the clock says valid: same outcome.
    w.state.access.delete(store(w).apps[w.appA.origin].access_token);
    w.log.length = 0;
    const [c, d] = await Promise.all([3, 4].map((n) => cli(w, ['app', 'call', w.appA.origin, 'add_note', `{"text":"${n}"}`])));
    assert.equal(c.status, 0, c.stderr);
    assert.equal(d.status, 0, d.stderr);
    assert.equal(w.log.filter((r) => r.path.endsWith('/token')).length, 1, 'one refresh');
    assert.equal(w.state.reuseRevocations, 0);

    const after = await cli(w, ['app', 'tools', w.appA.origin]);
    assert.equal(after.status, 0, 'still signed in: ' + after.stderr);
  } finally { w.close(); }
});

test('a lock left by a process that died is taken over, silently', async () => {
  const w = await world();
  try {
    assert.equal((await cli(w, ['app', 'login', w.appA.origin])).status, 0);
    // Expired, so this call must take the lock to refresh.
    const s = store(w);
    s.apps[w.appA.origin].access_expires_at = Date.now() - 1000;
    writeFileSync(join(w.config, 'app-mcp', 'tokens.json'), JSON.stringify(s), { mode: 0o600 });
    const lock = join(w.config, 'app-mcp', 'tokens.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, old, old);
    const out = await cli(w, ['app', 'tools', w.appA.origin]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stderr, '');
    assert.equal(existsSync(lock), false);
    assert.equal(w.log.filter((r) => r.path.endsWith('/token')).length, 2, 'login, then the refresh behind the dead lock');
  } finally { w.close(); }
});

test('a token the app reflects back is not printed', async () => {
  const w = await world();
  try {
    assert.equal((await cli(w, ['app', 'login', w.appA.origin])).status, 0);
    w.state.echoToken = true;
    const token = store(w).apps[w.appA.origin].access_token;
    for (const extra of [[], ['--json']]) {
      const out = await cli(w, ['app', 'call', w.appA.origin, 'add_note', '{"text":"x"}', ...extra]);
      assert.equal(out.status, 0, out.stderr);
      assert.ok(!(out.stdout + out.stderr).includes(token), 'token redacted');
      assert.match(out.stdout, /\[redacted\]/);
    }
  } finally { w.close(); }
});
