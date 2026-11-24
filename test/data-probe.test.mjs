import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { UserSession } from '../dist/testing.js';
import { _fixtureClientForTests, expectRefused } from '../dist/lib/playwright-fixtures.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const exec = promisify(execFile);
const digest = 'a'.repeat(64);
const bearer = session => ['Bearer', session].join(' ');
const access = { filtered: true, by: 'owner' };

test('data command fills the contract and acts only as the selected app user', async () => {
  const root = mkdtempSync(join(tmpdir(), 'data-probe-'));
  const config = join(root, 'config');
  const state = join(root, '.somewhere', 'test');
  mkdirSync(config);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'fixture-developer' }));
  writeFileSync(join(root, '.somewhere.json'), JSON.stringify({ project_id: 'fixture' }));

  const calls = [];
  const answers = [
    [200, { data: { id: 1 } }],
    [200, { data: null, access }],
    [404, { error: 'DATA_NOT_FOUND' }],
    [409, { error: 'DATA_CONTRACT_MISMATCH', current_contract_digest: digest }],
    [400, { error: 'DATA_CONTRACT_MISSING' }],
  ];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const auth = req.headers.authorization;
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/v1/projects/fixture/urls') {
      calls.push({ auth, path: url.pathname });
      res.end(JSON.stringify({ ok: true, data: { prod_fallback: origin } }));
    } else if (url.pathname === '/v1/db/access-map') {
      calls.push({ auth, path: url.pathname, project: url.searchParams.get('project_id') });
      res.end(JSON.stringify({ ok: true, data: { release: { id: 'release' }, browser_data: { contract_digest: digest } } }));
    } else if (url.pathname === '/__sw/data') {
      let text = '';
      for await (const chunk of req) text += chunk;
      calls.push({ auth, path: url.pathname, origin: req.headers.origin, input: JSON.parse(text) });
      const [status, body] = answers.shift();
      res.writeHead(status).end(JSON.stringify(body));
    } else {
      res.writeHead(404).end('{}');
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(state, 'manifest.json'), JSON.stringify({
    schema: 1, project_id: 'fixture', origin, actors: [
      { name: 'alice', user_id: 'a', email: 'a@example.test', state_file: 'alice.state.json' },
      { name: 'bob', user_id: 'b', email: 'b@example.test', state_file: 'bob.state.json' },
    ],
  }));
  for (const user of ['alice', 'bob']) {
    writeFileSync(join(state, user + '.state.json'), JSON.stringify({
      cookies: [{ name: '__Host-token', value: `fixture.${user}.sig`, domain: '127.0.0.1', path: '/', secure: true }],
    }));
  }
  const env = { ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: origin + '/v1', CI: '1' };
  const run = async (args, expectedExit, session) => {
    let out;
    try {
      out = await exec(process.execPath, [cli, 'data', ...args], { cwd: root, env: { ...env, SOMEWHERE_APP_SESSION: session } });
    } catch (error) {
      assert.equal(error.code, expectedExit, error.stderr);
      out = error;
    }
    assert.equal(out.code ?? 0, expectedExit);
    return JSON.parse(out.stdout);
  };
  try {
    assert.equal((await run(['get', 'notes', '--id', '1', '--as', 'alice'], 0)).data.id, 1);
    const empty = await run(['get', 'notes', '--id', '1', '--as', 'bob'], 0);
    assert.deepEqual([empty.kind, empty.data, empty.access], ['empty', null, access]);
    assert.equal((await run(['update', 'notes', '--id', '1', '--values', '{"title":"other"}', '--as', 'bob'], 1)).kind, 'missing-or-refused');
    const stale = await run(['get', 'notes', '--id', '1'], 1, 'fixture.bob.sig');
    assert.deepEqual([stale.kind, stale.current_contract_digest], ['stale-contract', digest]);
    assert.equal((await run(['list', 'notes', '--as', 'bob'], 1)).kind, 'missing-contract');
    const dataCalls = calls.filter(call => call.path === '/__sw/data');
    assert.deepEqual(dataCalls.map(call => call.auth), [bearer('fixture.alice.sig'), ...Array(4).fill(bearer('fixture.bob.sig'))]);
    assert.ok(dataCalls.every(call => call.origin === origin && call.input.contract === digest));
    assert.deepEqual(dataCalls[2].input, { contract: digest, operation: 'update', table: 'notes', id: '1', values: { title: 'other' } });
    assert.ok(calls.filter(call => call.path.startsWith('/v1')).every(call => call.auth === bearer('fixture-developer')));
    assert.ok(calls.filter(call => call.path === '/v1/db/access-map').every(call => call.project === 'fixture'));
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('UserSession fills the contract pinned by the runner and retains explicit-contract calls', async (t) => {
  const origin = 'https://app.example.test';
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'data-user-session-'));
  process.chdir(root);
  t.after(() => { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, '.somewhere.json'), JSON.stringify({ project_id: 'fixture' }));
  const target = process.env.SW_TEST_TARGET;
  process.env.SW_TEST_TARGET = JSON.stringify({ projectId: 'fixture', origin, contractDigest: digest });
  t.after(() => {
    if (target === undefined) delete process.env.SW_TEST_TARGET;
    else process.env.SW_TEST_TARGET = target;
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url: url.href, origin: opts.headers.get('Origin'), body: JSON.parse(opts.body) });
    return Response.json({ data: [], access });
  });
  const session = new UserSession(origin);
  await session.data('notes', { operation: 'list' });
  await session.data('notes', 'explicit', { operation: 'list' });
  assert.deepEqual(calls, [digest, 'explicit'].map(contract => ({
    url: origin + '/__sw/data', origin, body: { table: 'notes', contract, operation: 'list' },
  })));
  await assert.rejects(new UserSession('https://other.example.test').data('notes', { operation: 'list' }), /different app/);
});

test('the Playwright refusal helper fails contract errors even with a positive control', async () => {
  const allowed = _fixtureClientForTests({ post: () => { throw new Error('unexpected control read'); } }, digest);
  for (const [status, error] of [[400, 'DATA_CONTRACT_MISSING'], [409, 'DATA_CONTRACT_MISMATCH'], [403, 'DATA_ORIGIN_FORBIDDEN']]) {
    const denied = _fixtureClientForTests({
      post: async (_path, { data }) => {
        assert.equal(data.contract, digest);
        return { status: () => status, json: async () => ({ error }) };
      },
    }, digest);
    await assert.rejects(expectRefused(denied, 'notes', { operation: 'get', id: 1 }, { allowed }), /proves nothing about access/);
  }
});
