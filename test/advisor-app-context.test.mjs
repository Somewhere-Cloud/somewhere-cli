// The CLI gathers the linked app's facts with the user's own sign-in and sends them as context; the Advisor fetches
// nothing and keeps nothing. Follow-ups live in the linked folder only, for that app and that signed-in account:
// two folders, two apps, two sign-ins, --new, --no-project and anonymous --project are shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

test('advisor sends the linked app it read with the user sign-in, and folder-kept follow-ups per app and account', async () => {
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
    if (url.pathname === '/mcp' && body?.method === 'tools/call') { calls.push({ auth: req.headers.authorization, args: body.params.arguments }); n += 1; return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `ANSWER_${n}` }] } })); }
    if (url.pathname === '/mcp') { res.statusCode = 202; return res.end(); }
    api.push({ path: url.pathname + url.search, auth: req.headers.authorization });
    const project = url.pathname.match(/^\/v1\/projects\/([^/]+)$/)?.[1];
    if (project) { const app = apps[project] ?? byId[project]; if (!app) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'PROJECT_NOT_FOUND', message: 'Project not found.' })); } return res.end(JSON.stringify({ ok: true, data: { id: app.id, name: app.name, live_release: { id: 'rel_1', version: 2 } } })); }
    if (url.pathname === '/v1/project-docs') return res.end(JSON.stringify({ ok: true, data: { release_id: 'rel_1', project_overview: { app: 'Pages and API', api_routes: [`POST /api/${byId[url.searchParams.get('project_id')]?.name}-book (auth=none)`], more: 'x' } } }));
    if (/^\/v1\/projects\/[^/]+\/deploys$/.test(url.pathname)) return res.end(JSON.stringify({ ok: true, data: { deploys: [{ status: 'success', version: 2, promoted_at: '2026-11-23T01:00:00Z' }] } }));
    res.statusCode = 405; res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const folder = (project) => { const dir = mkdtempSync(join(tmpdir(), 'advisor-app-folder-')); writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: project })); return dir; };
  const signIn = (email) => { const dir = mkdtempSync(join(tmpdir(), 'advisor-app-config-')); writeFileSync(join(dir, 'config.json'), JSON.stringify(email ? { token: 'smt_fixture_only', user: { email } } : {})); return dir; };
  const cli = join(process.cwd(), 'dist/index.js');
  const ask = (cwd, config, question, flags = []) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'advisor', question, ...flags], { cwd, env: { ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_MCP_URL: base + '/mcp', SOMEWHERE_API_URL: base + '/v1', SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1' } });
    let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  const one = folder('app-one'), two = folder('app-two');
  const alice = signIn('alice@example.test'), bob = signIn('bob@example.test'), anonymous = signIn(null);
  try {
    // The CLI reads app-one with the user's sign-in and sends it; the Advisor fetches nothing.
    let r = await ask(one, alice, 'MARKER_ONE how do I add a table?');
    assert.equal(r.code, 0, r.err);
    let sent = calls.at(-1).args;
    assert.equal(sent.project_id, apps['app-one'].id);
    assert.match(sent.context.app, /APP OVERVIEW[\s\S]*one-book/); assert.doesNotMatch(sent.context.app, /"more"/);
    assert.equal(sent.context.earlier, undefined, 'the first question has no earlier turns');
    assert.ok(api.every((a) => a.auth === ['Bearer', 'smt_fixture_only'].join(' ')), 'every app read uses the user sign-in');
    assert.ok(existsSync(join(one, '.somewhere', 'advisor-conversation.json')), 'kept in the linked folder');
    // Same folder, same sign-in: the follow-up carries the earlier turn.
    r = await ask(one, alice, 'And how do I deploy it?');
    sent = calls.at(-1).args;
    assert.deepEqual(sent.context.earlier.map((t) => t.question), ['MARKER_ONE how do I add a table?']);
    // Another folder, linked to another app: nothing from folder one.
    r = await ask(two, alice, 'What did I ask before?');
    sent = calls.at(-1).args;
    assert.match(sent.context.app, /two-book/); assert.equal(sent.context.earlier, undefined, 'another folder never sees folder one');
    // Another app named in folder one: not that folder's conversation.
    r = await ask(one, alice, 'What about this app?', ['--project', 'app-two']);
    assert.equal(calls.at(-1).args.context.earlier, undefined, 'a different app than the folder is linked to keeps no turns');
    // Another sign-in in folder one: sees nothing.
    r = await ask(one, bob, 'What was asked here?');
    assert.equal(calls.at(-1).args.context.earlier, undefined, 'another sign-in in the same folder sees nothing');
    // --new forgets; --no-project sends no app.
    r = await ask(one, alice, 'Fresh start', ['--new']);
    assert.equal(calls.at(-1).args.context.earlier, undefined, '--new starts over');
    r = await ask(one, alice, 'Generic question', ['--no-project']);
    assert.equal(calls.at(-1).args.project_id, undefined); assert.equal(calls.at(-1).args.context?.app, undefined);
    // Anonymous --project stops with the sign-in instruction; nothing is read or sent.
    const before = { calls: calls.length, api: api.length };
    r = await ask(one, anonymous, 'About my app', ['--project', 'app-one']);
    assert.equal(r.code, 1); assert.match(r.err + r.out, /needs a sign-in/);
    assert.equal(calls.length, before.calls); assert.equal(api.length, before.api);
    // An app this sign-in cannot read stops before any question is sent.
    r = await ask(one, alice, 'About a stranger app', ['--project', 'app-nobody']);
    assert.equal(r.code, 1); assert.equal(calls.length, before.calls, 'nothing asked about an unreadable app');
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
