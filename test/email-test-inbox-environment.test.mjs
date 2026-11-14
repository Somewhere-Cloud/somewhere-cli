import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function credentialHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_inbox_env_test',
    user: { email: 'inbox@example.com', username: 'cron' },
  }) + '\n');
  return home;
}

function run(args, env, cwd = repoRoot) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function sendJson(res, payload) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function fixtureServer(callTool) {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      if (rpc.method === 'initialize') {
        sendJson(res, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'cron-run-test', version: '1.0.0' },
          },
        });
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
        return;
      }
      if (rpc.method === 'tools/call') {
        sendJson(res, { jsonrpc: '2.0', id: rpc.id, result: callTool(rpc.params) });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
}

async function withFixture(callTool, fn) {
  const server = fixtureServer(callTool);
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}/mcp`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

function toolSuccess(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }],
  };
}


const ADDRESS = 'ann@app.test.somewhere.site';
const messages = [
  { id: 'm1', to: ADDRESS, subject: 'Welcome', html: null, text: 'from preview', created_at: '2026-11-13T00:00:02.000Z', magic_link: null, verification_code: null, environment: 'preview', preview_session_id: 'draft_abc' },
  { id: 'm2', to: ADDRESS, subject: 'Verify your email', html: null, text: 'from live', created_at: '2026-11-13T00:00:01.000Z', magic_link: null, verification_code: '123456', environment: 'production', preview_session_id: null },
];

test('email test-inbox says who sent each message and forwards the environment filters', async () => {
  const home = credentialHome('sw-inbox-env-home-');
  const calls = [];
  await withFixture((params) => { calls.push(params.arguments); return toolSuccess({ address: ADDRESS, messages, limit: 20 }); }, async (url) => {
    const env = { HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: url };
    const all = await run(['email', 'test-inbox', ADDRESS, '--project', 'app'], env);
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /Welcome\nsent by: preview draft_abc\n/);
    assert.match(all.stdout, /Verify your email\nsent by: live app\n/);
    assert.equal((await run(['email', 'test-inbox', ADDRESS, '--project', 'app', '--preview'], env)).status, 0);
    assert.equal((await run(['email', 'test-inbox', ADDRESS, '--project', 'app', '--preview', 'draft_abc'], env)).status, 0);
    assert.equal((await run(['email', 'test-inbox', ADDRESS, '--project', 'app', '--production'], env)).status, 0);
    const both = await run(['email', 'test-inbox', ADDRESS, '--project', 'app', '--preview', '--production'], env);
    assert.equal(both.status, 1);
  });
  assert.deepEqual(calls.map((args) => [args.environment, args.preview_session_id]), [
    [undefined, undefined], ['preview', undefined], [undefined, 'draft_abc'], ['production', undefined],
  ]);
});
