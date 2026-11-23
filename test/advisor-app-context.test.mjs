// In a folder linked to an app, the CLI reads that app with the user's own sign-in and sends it as context: the
// overview exactly as project_get returns it, and the last deploy. The Advisor reads nothing and keeps nothing.
// Follow-ups live in that folder only, for that app and that signed-in account. Shown: two folders, two apps,
// two sign-ins, --new, --no-context, an unlinked folder, anonymous, an unreadable app, and the .gitignore line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

test('advisor sends the linked app read with the user sign-in, and folder-kept follow-ups per app and account', async () => {
  const apps = { 'app-one': { id: '11111111-1111-4111-8111-111111111111', name: 'one' }, 'app-two': { id: '22222222-2222-4222-8222-222222222222', name: 'two' } };
  const byId = Object.fromEntries(Object.values(apps).map((a) => [a.id, a]));
  const calls = []; const api = [];
  let n = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/mcp' && body?.method === 'initialize') return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }));
    if (url.pathname === '/mcp' && body?.method === 'tools/call') { calls.push({ args: body.params.arguments }); n += 1; return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `ANSWER_${n}` }] } })); }
    if (url.pathname === '/mcp') { res.statusCode = 202; return res.end(); }
    if (url.pathname === '/advisor') { calls.push({ args: body, anonymous: true }); return res.end(JSON.stringify({ ok: true, data: { answer: 'ANON' } })); }
    api.push({ path: url.pathname + url.search, auth: req.headers.authorization });
    const project = url.pathname.match(/^\/v1\/projects\/([^/]+)$/)?.[1];
    if (project) { const app = apps[project] ?? byId[project]; if (!app) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'PROJECT_NOT_FOUND', message: 'Project not found.' })); } return res.end(JSON.stringify({ ok: true, data: { id: app.id, name: app.name, live_release: { id: 'rel_1', version: 2 } } })); }
    if (url.pathname === '/v1/project-docs') return res.end(JSON.stringify({ ok: true, data: { release_id: 'rel_1', project_overview: { app: 'Pages and API', api_routes: [`ALL /api/${byId[url.searchParams.get('project_id')]?.name}-book → api/book.ts (auth=none)`], more: 'docs_query(...)' } } }));
    if (/^\/v1\/projects\/[^/]+\/deploys$/.test(url.pathname)) return res.end(JSON.stringify({ ok: true, data: { deploys: [{ status: 'rejected', code: 'BUILD_ERROR', message: 'The new version could not be built.', at: '2026-11-23T02:00:00Z' }, { status: 'success', version: 2, promoted_at: '2026-11-23T01:00:00Z' }] } }));
    if (url.pathname === '/v1/deploy/log') return res.end(JSON.stringify({ ok: true, data: { last_failure: { kind: 'build_error', errors: [{ file: 'api/book.ts', line: 1, column: 43, message: 'Expected identifier' }] } } }));
    res.statusCode = 405; res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const folder = (project) => { const dir = mkdtempSync(join(tmpdir(), 'advisor-app-folder-')); if (project) writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: project })); return dir; };
  const signIn = (email) => { const dir = mkdtempSync(join(tmpdir(), 'advisor-app-config-')); writeFileSync(join(dir, 'config.json'), JSON.stringify(email ? { token: 'smt_fixture_only', user: { email } } : {})); return dir; };
  const cli = join(process.cwd(), 'dist/index.js');
  const ask = (cwd, config, question, flags = []) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'advisor', question, ...flags], { cwd, env: { ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_MCP_URL: base + '/mcp', SOMEWHERE_API_URL: base + '/v1', SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1' } });
    let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  const one = folder('app-one'), two = folder('app-two'), unlinked = folder(null), stranger = folder('app-nobody');
  const alice = signIn('alice@example.test'), bob = signIn('bob@example.test'), anonymous = signIn(null);
  const token = ['Bearer', 'smt_fixture_only'].join(' ');
  try {
    let r = await ask(one, alice, 'MARKER_ONE how do I add a table?');
    assert.equal(r.code, 0, r.err);
    let sent = calls.at(-1).args;
    assert.equal(sent.project_id, undefined, 'no project reference: the facts themselves are sent');
    assert.deepEqual(sent.context.app_overview.api_routes, ['ALL /api/one-book → api/book.ts (auth=none)'], 'the overview exactly as project_get returns it');
    assert.deepEqual(sent.context.last_deploy, { status: 'failed', code: 'BUILD_ERROR', file: 'api/book.ts', line: 1, column: 43, message: 'Expected identifier' });
    assert.equal(sent.context.earlier, undefined);
    assert.match(r.err, /Sent this app's overview and its last deploy, read with your sign-in/);
    assert.ok(api.length >= 4 && api.every((a) => a.auth === token), 'every app read uses the user sign-in');
    assert.ok(existsSync(join(one, '.somewhere', 'advisor-conversation.json')), 'kept in the linked folder');
    assert.match(readFileSync(join(one, '.gitignore'), 'utf8'), /^\.somewhere\/$/m, 'the folder state is git-ignored');
    r = await ask(one, alice, 'And how do I deploy it?');
    assert.deepEqual(calls.at(-1).args.context.earlier.map((t) => t.question), ['MARKER_ONE how do I add a table?']);
    r = await ask(two, alice, 'What did I ask before?');
    assert.match(calls.at(-1).args.context.app_overview.api_routes[0], /two-book/); assert.equal(calls.at(-1).args.context.earlier, undefined, 'another folder never sees folder one');
    r = await ask(one, bob, 'What was asked here?');
    assert.equal(calls.at(-1).args.context.earlier, undefined, 'another sign-in in the same folder sees nothing');
    r = await ask(one, alice, 'Fresh start', ['--new']);
    assert.equal(calls.at(-1).args.context.earlier, undefined, '--new starts over');
    const apiBefore = api.length;
    r = await ask(one, alice, 'Generic question', ['--no-context']);
    assert.equal(calls.at(-1).args.context, undefined, '--no-context sends only the question'); assert.equal(api.length, apiBefore, 'and reads nothing');
    r = await ask(unlinked, alice, 'Generic question');
    assert.equal(calls.at(-1).args.context, undefined, 'outside an app folder nothing is sent'); assert.equal(api.length, apiBefore);
    r = await ask(one, anonymous, 'About my app');
    assert.equal(r.code, 0, r.err); assert.equal(calls.at(-1).anonymous, true); assert.equal(calls.at(-1).args.context?.app_overview, undefined);
    assert.match(r.err, /Not signed in, so this folder's app was not sent/); assert.equal(api.length, apiBefore, 'anonymous reads nothing');
    r = await ask(stranger, alice, 'About a stranger app');
    assert.equal(r.code, 0, r.err); assert.match(r.err, /Could not read this folder's app/); assert.equal(calls.at(-1).args.context?.app_overview, undefined);
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
