import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The deploy body may have reached the server and no authoritative answer was
// read (pfb_47695233e613): the request is never sent again, the outcome is
// reported as unknown with deploy-history readback, and nothing says "not
// applied" or advises a retry. A connection that never opened sent nothing.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let deployPosts = 0;
let mode = 'drop';
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/deploy')) {
      deployPosts += 1;
      if (mode === 'drop') return req.socket.destroy(); // whole body read, then no answer
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_fixture' });
      res.write('{"ok":true,"data":{"version":'); // headers and part of the body arrive...
      if (mode === 'body-drop') setTimeout(() => res.socket.destroy(), 50); // ...then the connection drops
      return; // body-stall: never finishes
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { notices: [] } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => { server.closeAllConnections?.(); server.close(); });

function run(args, apiUrl = `http://127.0.0.1:${server.address().port}/v1`, extraEnv = {}) {
  const base = mkdtempSync(join(tmpdir(), 'sw-unknown-outcome-'));
  const app = join(base, 'app'), config = join(base, 'config');
  mkdirSync(join(app, 'api'), { recursive: true }); mkdirSync(config);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'dev@example.test', username: 'dev' } }));
  writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: 'proj_fixture', name: 'Fixture', subdomain: 'fixture' }));
  writeFileSync(join(app, 'index.html'), '<html><body>hi</body></html>\n');
  writeFileSync(join(app, 'api/hello.ts'), 'export default async () => new Response("hi");\n');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: apiUrl,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1', ...extraEnv,
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr }));
  });
}

function assertUnknownOutcome(out) {
  assert.match(out, /Its outcome is unknown: it may have gone live, may have been refused, or may still be running\. It was not sent again, and this CLI cannot confirm what happened to it\./);
  assert.match(out, /Look, for investigation only: somewhere call project_deploys '\{"project_id":"proj_fixture"\}'/);
  // Collision case: another actor's deploy can land in history while this one
  // still runs, and clocks differ. No history entry is ever offered as this
  // request's outcome or as permission to deploy again.
  assert.match(out, /No entry there is tied to this request, and deploys by anyone else can appear in it, so a later entry does not show what happened to this one\./);
  assert.match(out, /Ask for help with this reference so the platform can find this exact request: project proj_fixture, sent at \S+ \(this machine's clock\)/);
  assert.doesNotMatch(out, /settles|until it does|entry after|Check your network and retry|NOT applied|not a server rejection|retrying once/);
}

for (const args of [['deploy'], ['deploy', '--force', '--yes'], ['deploy', '--scope', 'functions']]) {
  test(`\`${args.join(' ')}\`: an unanswered request is sent once and reported as unknown outcome`, async () => {
    mode = 'drop'; deployPosts = 0;
    const result = await run(args);
    assert.equal(result.status, 1, result.out);
    assert.equal(deployPosts, 1);
    assertUnknownOutcome(result.out);
  });
}

test('--json reports deployment_outcome unknown with the readback details', async () => {
  mode = 'drop'; deployPosts = 0;
  const result = await run(['deploy', '--json']);
  assert.equal(result.status, 1);
  assert.equal(deployPosts, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.deployment_outcome, 'unknown');
  assert.equal(payload.error, 'NETWORK_ERROR');
  assert.equal(payload.project_id, 'proj_fixture');
  assert.ok(!Number.isNaN(Date.parse(payload.request_started_at)));
  assertUnknownOutcome(payload.message);
});

test('headers arrive, then the body is cut off: unknown outcome, not resent', async () => {
  mode = 'body-drop'; deployPosts = 0;
  const result = await run(['deploy', '--json']);
  assert.equal(result.status, 1, result.out);
  assert.equal(deployPosts, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.deployment_outcome, 'unknown');
  assert.equal(payload.request_id, 'req_fixture');
  assert.match(payload.message, /got a response that was cut off before its result could be read/);
  assert.match(payload.message, /request req_fixture/, 'the reference names the request id the response carried');
  assertUnknownOutcome(payload.message);
});

test('headers arrive, then the body stalls past the deadline: unknown outcome, not resent', async () => {
  mode = 'body-stall'; deployPosts = 0;
  const result = await run(['deploy'], undefined, { SOMEWHERE_DEPLOY_TIMEOUT_MS: '400' });
  assert.equal(result.status, 1, result.out);
  assert.equal(deployPosts, 1);
  assertUnknownOutcome(result.out);
});

test('a connection that never opened keeps its retry advice: nothing was sent', async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const result = await run(['deploy'], `http://127.0.0.1:${port}/v1`);
  assert.equal(result.status, 1);
  assert.match(result.out, /ECONNREFUSED/);
  assert.doesNotMatch(result.out, /outcome is unknown/);
});
