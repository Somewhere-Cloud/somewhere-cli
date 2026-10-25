// tsk_da2dba3d: distinguish local call admission from platform/unknown outcomes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const noCall = /The requested tool was not called\./;

test('local call errors explain correction before tool dispatch, in text and JSON', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'sw-call-local-'));
  const config = join(scratch, 'config');
  const app = join(scratch, 'app');
  mkdirSync(config);
  mkdirSync(app);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_local_fixture' }));
  // Even a linked directory must not trigger discovery for rejected input.
  writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: 'fixture-project' }));
  let requests = 0;
  const calls = [];
  let outcome = 'success';
  const server = createServer((req, res) => {
    requests++;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (outcome === 'transport') { req.socket.destroy(); return; }
      const rpc = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      let result = {};
      if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      if (rpc.method === 'tools/list') result = { tools: [{ name: 'db_browse', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } } } }] };
      if (rpc.method === 'tools/call') {
        calls.push(rpc.params);
        const value = outcome === 'refusal'
          ? { ok: false, error: 'VALIDATION_ERROR', message: 'Fixture refusal', retry: false, http_status: 400, trace_id: 'trace_fixture_1234' }
          : { ok: true, data: { rows: [] } };
        result = { ...(outcome === 'refusal' ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] };
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', ...(rpc.id !== undefined ? { id: rpc.id } : {}), result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_MCP_URL: `${base}/mcp`, SOMEWHERE_API_URL: `${base}/v1`, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' };
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: app, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  try {
    const cases = [
      { args: ['call', 'db_browse', '{'], correction: /double-quoted property names.*somewhere call --help/ },
      ...['[]', 'null', '1', '"text"'].map((value) => ({ args: ['call', 'db_browse', value], correction: /JSON object, for example/ })),
      { args: ['call'], correction: /somewhere call --list/ },
      { args: ['call', 'db_browse', '{}', '--list'], correction: /somewhere call --list.*without a tool name or JSON arguments/ },
      { args: ['call', 'db_browse', '{"project_id":"default"}', '--all-projects'], correction: /Remove --all-projects.*remove "project_id"/ },
    ];
    for (const entry of cases) for (const json of [false, true]) await t.test(`${entry.args.join(' ')} ${json ? 'JSON' : 'text'}`, async () => {
      const before = requests;
      const result = await run([...entry.args, ...(json ? ['--json'] : [])]);
      assert.equal(result.status, 1);
      const message = json ? JSON.parse(result.stdout).message : result.stderr;
      assert.match(message, noCall);
      assert.match(message, entry.correction);
      if (json) {
        assert.equal(JSON.parse(result.stdout).error, 'CLI_ERROR');
        assert.equal(JSON.parse(result.stdout).ok, false);
      }
      assert.equal(requests, before, 'isolated local validation sends no HTTP requests');
      assert.equal(calls.length, 0);
    });
    await t.test('suggested help and discovery commands exist; corrected JSON dispatches once', async () => {
      const help = await run(['call', '--help']);
      assert.equal(help.status, 0);
      assert.match(help.stdout, /call.*tool.*json/);
      const list = await run(['call', '--list', '--json']);
      assert.equal(list.status, 0, list.stderr);
      assert.equal(JSON.parse(list.stdout).tools[0].name, 'db_browse');
      const result = await run(['call', 'db_browse', '{"project_id":"default"}', '--json']);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, data: { rows: [] } });
      assert.deepEqual(calls, [{ name: 'db_browse', arguments: { project_id: 'default' } }]);
    });
    await t.test('platform refusal preserves code/retry/correlation without local-outcome wording', async () => {
      outcome = 'refusal';
      const result = await run(['call', 'db_browse', '{"project_id":"default"}', '--json']);
      assert.equal(result.status, 1);
      const value = JSON.parse(result.stdout);
      assert.equal(value.error, 'VALIDATION_ERROR');
      assert.equal(value.message, 'Fixture refusal');
      assert.equal(value.retry, false);
      assert.equal(value.trace_id, 'trace_fixture_1234');
      assert.doesNotMatch(result.stdout + result.stderr, noCall);
    });
    await t.test('missing response never claims the requested tool was not called', async () => {
      outcome = 'transport';
      const result = await run(['call', 'db_browse', '{"project_id":"default"}', '--json']);
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout + result.stderr, noCall);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  }
});
