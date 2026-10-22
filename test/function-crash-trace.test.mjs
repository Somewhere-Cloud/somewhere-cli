import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsk_da2dba3d slice 2b: a deployed function's crash (500 FUNCTION_ERROR + trace_id) is investigated
// with `logs --trace` and packaged with `support packet --trace`. The owner's log rows carry the
// caller's input in the message, the stack, the path and extra data fields (as a real handler's
// rethrow does); the packet reads only code/status/request id/method/path-template, so none of it may
// reach the packet or its output. The log reader itself is the owner's own diagnostics and shows the stack.
const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const TRACE = '41121a928f6dcdb16e05709a9349bb91';
const CANARIES = ['guest-canary-2b91f@example.com', 'tok_canary-2b91f', 'pw-canary-2b91f', 'sess-canary-2b91f', 'CANARY-stack-frame', '$(rm -rf ~)'];

const seen = [];
let rows = [];
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  seen.push(req.url);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, data: { logs: rows } }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const crashRows = () => [
  { id: 'l2', level: 'error', source: 'server', created_at: '2026-10-22T05:51:22.000Z',
    message: 'FUNCTION_ERROR: booking failed for guest-canary-2b91f@example.com (tok_canary-2b91f): Invalid time value',
    data: { code: 'FUNCTION_ERROR', request_id: 'a4e63acfcf65efbd', method: 'POST', path: '/api/bookings/guest-canary-2b91f@example.com', route: '/api/bookings/[guest]',
      status: 500, slot: 'prod', stack: 'Error: booking failed for guest-canary-2b91f@example.com\n    at handler (CANARY-stack-frame)', password: 'pw-canary-2b91f', query: '?session=sess-canary-2b91f', note: '$(rm -rf ~)' } },
  { id: 'l1', level: 'error', source: 'function', created_at: '2026-10-22T05:51:21.000Z',
    message: 'POST /api/bookings/guest-canary-2b91f@example.com → 500 (135ms)',
    data: { path: '/api/bookings/guest-canary-2b91f@example.com', status: 500, request_id: 'a4e63acfcf65efbd', duration_ms: 135 } },
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sw-crash-'));
  const configDir = join(root, 'config'); const app = join(root, 'app');
  mkdirSync(configDir); mkdirSync(app);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'dev@fixture.test', username: 'd' } }));
  writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: 'proj_7c1b2a9d4e' }));
  return { app, configDir };
}
function run(args, { app, configDir }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distIndex, ...args], { cwd: app, env: { ...process.env, NO_COLOR: '1', SOMEWHERE_API_URL: apiUrl, SOMEWHERE_CONFIG_DIR: configDir } });
    let out = ''; child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c));
    child.on('close', (status) => resolve({ status, out }));
  });
}
const leaks = (text) => CANARIES.filter((c) => text.includes(c));
const lastQuery = () => new URL(seen.at(-1), apiUrl).searchParams;

test('logs --trace reads exactly that request and shows its recorded stack', async () => {
  rows = crashRows();
  const fx = fixture();
  const r = await run(['logs', '--trace', TRACE.toUpperCase()], fx);
  assert.equal(r.status, 0, r.out);
  assert.equal(lastQuery().get('trace_id'), TRACE, 'normalized to the lowercase id the reader matches');
  assert.equal(lastQuery().get('project_id'), 'proj_7c1b2a9d4e');
  assert.match(r.out, /FUNCTION_ERROR: booking failed/);
  assert.match(r.out, /at handler \(CANARY-stack-frame\)/, 'the stack is printed under its line');
  const plain = await run(['logs'], fx);
  assert.doesNotMatch(plain.out, /at handler/, 'without --trace the output is unchanged: no stacks');
  assert.equal(new URL(seen.at(-1), apiUrl).searchParams.get('trace_id'), null);
});

test('logs --trace refuses anything but a 32-hex id before any request', async () => {
  const fx = fixture();
  for (const bad of ['abc', '$(rm -rf ~)', `${TRACE}x`, `-${TRACE.slice(1)}`]) {
    const before = seen.length;
    const r = await run(['logs', '--trace', bad], fx);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /--trace takes the 32-character trace_id/);
    assert.equal(seen.length, before, `no request for ${bad}`);
  }
});

test('support packet --trace builds the packet from typed fields only; no caller input or crash text', async () => {
  rows = crashRows();
  const fx = fixture();
  const json = await run(['support', 'packet', '--trace', TRACE, '--json'], fx);
  assert.equal(json.status, 0, json.out);
  assert.deepEqual(leaks(json.out), [], `packet leaked: ${json.out}`);
  const packet = JSON.parse(json.out);
  const c = packet.collected;
  assert.deepEqual([c.code, c.http_status, c.operation, c.request_id, c.trace_id, c.project_id, c.outcome, c.captured_at],
    ['FUNCTION_ERROR', 500, 'POST /:id/:id/:seg', 'a4e63acfcf65efbd', TRACE, 'proj_7c1b2a9d4e', 'unknown', '2026-10-22T05:51:22.000Z']);
  for (const forbidden of ['message', 'stack', 'data', 'path', 'route', 'password', 'command']) assert.ok(!(forbidden in c), forbidden);
  assert.equal(packet.surface, 'function_crash');
  assert.deepEqual(packet.recipe.investigate, [['somewhere', 'logs', '--project', 'proj_7c1b2a9d4e', '--trace', TRACE]]);
  assert.equal(packet.recipe.rerun_original, false);
  assert.ok(packet.recipe.steps.some((s) => /Do NOT resend the failed request/.test(s)));
  assert.deepEqual(packet.submit, { destination: 'support_ticket', automatic: false, how: 'Review this packet, then submit it deliberately as a platform bug.' });
  const text = await run(['support', 'packet', '--trace', TRACE, '--project', 'proj_other0001'], fx);
  assert.equal(text.status, 0, text.out);
  assert.equal(lastQuery().get('project_id'), 'proj_other0001', '--project names the project read');
  assert.deepEqual(leaks(text.out), [], `packet text leaked: ${text.out}`);
  assert.match(text.out, /somewhere logs --project proj_other0001 --trace 41121a928f6dcdb16e05709a9349bb91/);
  assert.match(text.out, /never retry it blindly/);
});

test('support packet --trace with no failure under that trace says so and exits 1', async () => {
  rows = [crashRows()[1]]; // the access line alone carries no reported code
  const fx = fixture();
  const r = await run(['support', 'packet', '--trace', TRACE, '--json'], fx);
  assert.equal(r.status, 1, r.out);
  assert.equal(JSON.parse(r.out).error, 'NO_FAILURE_RECORDED');
  assert.deepEqual(leaks(r.out), []);
  const bad = await run(['support', 'packet', '--trace', 'not-a-trace'], fx);
  assert.equal(bad.status, 1);
  assert.match(bad.out, /--trace takes the 32-character trace_id/);
  const stray = await run(['support', 'packet', '--project', 'proj_7c1b2a9d4e'], fx);
  assert.equal(stray.status, 1);
  assert.match(stray.out, /--project goes with --trace/);
});
