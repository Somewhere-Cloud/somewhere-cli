import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// pfb_3769086f6aa7: a platform refusal of POST /v1/deploy/check keeps its own
// code under --json (as `deploy --json` does), never the generic CLI_ERROR.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../bin/somewhere.js');
let reply;
let requests = [];
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  if (req.url === '/') { res.writeHead(404); res.end(); return; }
  requests.push(`${req.method} ${req.url}`);
  res.writeHead(reply.status, { 'content-type': 'application/json', 'x-request-id': 'req_fixture_0001' });
  res.end(JSON.stringify(reply.body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

function run(args) {
  requests = [];
  const base = mkdtempSync(join(tmpdir(), 'sw-deploy-check-json-'));
  const configDir = join(base, 'config');
  const app = join(base, 'app');
  mkdirSync(configDir);
  mkdirSync(join(app, 'api'), { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ token: 'smt_fixture_access', user: { email: 'dev@example.test', username: 'dev' } }));
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>x</title>');
  writeFileSync(join(app, 'api', 'form.ts'), 'export default async function (req) { return Response.json(await req.json()); }\n');
  const local = `http://127.0.0.1:${server.address().port}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: app,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, HOME: base, USERPROFILE: base, SOMEWHERE_CONFIG_DIR: configDir,
        SOMEWHERE_API_URL: `${local}/v1`, SOMEWHERE_MCP_URL: `${local}/mcp`, SOMEWHERE_RUNNER_URL: local,
        SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
      },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v);
    child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, stderr, requests }));
  });
}

for (const [code, message] of [
  ['ENDPOINT_BODY_UNDECLARED', 'api/form.ts reads the request body without declaring a body schema.'],
  ['ENDPOINT_AUTH_OMITTED', 'api/form.ts does not declare auth.'],
]) {
  test(`deploy-check --json keeps the platform code ${code}`, async () => {
    reply = { status: 400, body: { ok: false, error: code, message } };
    const json = await run(['deploy-check', '--project', 'proj_fixture', '--json']);
    assert.equal(json.status, 1, json.stdout + json.stderr);
    assert.deepEqual(json.requests, ['POST /v1/deploy/check']);
    const body = JSON.parse(json.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error, code);
    assert.equal(body.message, message);
    assert.equal(body.request_id, 'req_fixture_0001');

    const text = await run(['deploy-check', '--project', 'proj_fixture']);
    assert.equal(text.status, 1);
    assert.ok(text.stderr.includes(message), text.stderr);
    assert.ok(text.stderr.includes(code), text.stderr);
  });
}
