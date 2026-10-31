import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The deploy body reached the server and no answer came back: the deploy may
// be live. The CLI never says it was not applied, never advises a blind retry,
// and resends only a body the platform makes safe to resend (a full,
// non-forced deploy). --force and --scope deploys are sent once.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let deployPosts = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/deploy')) {
      deployPosts += 1;
      return req.socket.destroy(); // whole body read, then no answer
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { notices: [] } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

function run(args, apiUrl = `http://127.0.0.1:${server.address().port}/v1`) {
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
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr }));
  });
}

function assertUnknownOutcome(out) {
  assert.match(out, /may or may not have gone live/);
  assert.match(out, /Do not deploy again until you know/);
  assert.match(out, /`somewhere status`/);
  assert.doesNotMatch(out, /Check your network and retry|NOT applied|not a server rejection/);
}

test('a full deploy whose answer never arrives is resent once (safe), then reported as unknown outcome', async () => {
  deployPosts = 0;
  const result = await run(['deploy']);
  assert.equal(result.status, 1, result.out);
  assert.equal(deployPosts, 2);
  assertUnknownOutcome(result.out);
  assert.match(result.out, /the one safe resend got no answer either/);
});

test('--json reports deployment_outcome unknown on stdout', async () => {
  deployPosts = 0;
  const result = await run(['deploy', '--json']);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.deployment_outcome, 'unknown');
  assert.equal(payload.error, 'NETWORK_ERROR');
  assertUnknownOutcome(payload.message);
});

for (const args of [['deploy', '--force', '--yes'], ['deploy', '--scope', 'functions']]) {
  test(`\`${args.join(' ')}\` is never resent after an unanswered request`, async () => {
    deployPosts = 0;
    const result = await run(args);
    assert.equal(result.status, 1, result.out);
    assert.equal(deployPosts, 1);
    assertUnknownOutcome(result.out);
    assert.doesNotMatch(result.out, /resend/);
  });
}

test('a connection that never opened keeps its retry advice: nothing was sent', async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const result = await run(['deploy'], `http://127.0.0.1:${port}/v1`);
  assert.equal(result.status, 1);
  assert.match(result.out, /ECONNREFUSED/);
  assert.doesNotMatch(result.out, /may or may not have gone live/);
});
