import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reviewer 3606's packet boundary, from Journey's acceptance of tsk_da2dba3d:
// B2 (tsk_fca1267b): a packet's code comes only from the function runtime's CLOSED set of failure codes;
//   an app's own err.code (S11: a CODE-shaped canary, or a key id that matches the CODE regex) becomes
//   APP_ERROR_CODE and never appears in the packet.
// B3 (tsk_f184baa4): `logs` / `errors` TEXT output renders each stored row as one record with every
//   control character escaped (S10: a message forging an [info] row plus ANSI escapes). --json is faithful.
const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const TRACE = '84d6a1b2c3d4e5f60718293a4b5c6d7e';
const CODE_CANARY = 'CANARY_UPPERTOKEN_Z9Q4W1';
const KEY_SHAPED = 'AKIAIOSFODNN7EXAMPLE';

let logRows = [];
let errorRows = [];
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/v1/errors/recent')) return res.end(JSON.stringify({ ok: true, data: { errors: errorRows } }));
  res.end(JSON.stringify({ ok: true, data: { logs: logRows } }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sw-boundary-'));
  const configDir = join(root, 'config'); const app = join(root, 'app');
  mkdirSync(configDir); mkdirSync(app);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'dev@fixture.test', username: 'd' } }));
  writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: 'proj_7c1b2a9d4e' }));
  return { app, configDir };
}
function run(args, { app, configDir }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distIndex, ...args], { cwd: app, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', SOMEWHERE_API_URL: apiUrl, SOMEWHERE_CONFIG_DIR: configDir } });
    const out = []; child.stdout.on('data', (c) => out.push(c)); child.stderr.on('data', (c) => out.push(c));
    child.on('close', (status) => resolve({ status, bytes: Buffer.concat(out), out: Buffer.concat(out).toString('utf8') }));
  });
}
const crashRow = (data, extra = {}) => ({ id: 'l2', level: 'error', source: 'server', created_at: '2026-10-22T17:00:00.000Z',
  message: `${data.code}: booking failed`, data: { request_id: 'a4ea01d0ed7fbe62', method: 'POST', path: '/api/crash-code', status: 500, ...data }, ...extra });

test('B2: an app-chosen err.code never reaches the packet; only the runtime set or APP_ERROR_CODE', async () => {
  const fx = fixture();
  for (const appCode of [CODE_CANARY, KEY_SHAPED, 'SCOPE_VIOLATION_FAKE', 'FUNCTION_ERRORX']) {
    logRows = [crashRow({ code: appCode })];
    const r = await run(['support', 'packet', '--trace', TRACE, '--json'], fx);
    assert.equal(r.status, 0, r.out);
    const packet = JSON.parse(r.out);
    assert.equal(packet.collected.code, 'APP_ERROR_CODE', `${appCode} is mapped, not copied`);
    assert.equal(r.out.includes(appCode), false, `${appCode} appears nowhere in the packet`);
    const text = await run(['support', 'packet', '--trace', TRACE], fx);
    assert.equal(text.out.includes(appCode), false, `${appCode} appears nowhere in the text packet`);
  }
  // The server-recorded response code wins, even when the app's own code is a canary.
  logRows = [crashRow({ code: CODE_CANARY, response_code: 'FUNCTION_ERROR' })];
  let packet = JSON.parse((await run(['support', 'packet', '--trace', TRACE, '--json'], fx)).out);
  assert.equal(packet.collected.code, 'FUNCTION_ERROR');
  assert.equal(JSON.stringify(packet).includes(CODE_CANARY), false);
  // A runtime code in the closed set is kept (older rows without response_code).
  logRows = [crashRow({ code: 'RAW_SQL_CANNOT_BE_PLATFORM_SCOPED', status: 403 })];
  packet = JSON.parse((await run(['support', 'packet', '--trace', TRACE, '--json'], fx)).out);
  assert.equal(packet.collected.code, 'RAW_SQL_CANNOT_BE_PLATFORM_SCOPED');
  // A response_code outside the set is not trusted either.
  logRows = [crashRow({ code: 'FUNCTION_ERROR', response_code: CODE_CANARY })];
  packet = JSON.parse((await run(['support', 'packet', '--trace', TRACE, '--json'], fx)).out);
  assert.equal(packet.collected.code, 'FUNCTION_ERROR');
  assert.equal(JSON.stringify(packet).includes(CODE_CANARY), false);
});

const FORGE = 'ok\n  [info]  10:00:00 AM  FORGED login succeeded\r\x1b[2J\x1b[31mred\x07\u202ereversed\u2028next';
test('B3: logs and errors text render one record per row with no raw control bytes; --json stays faithful', async () => {
  const fx = fixture();
  logRows = [
    { id: 'a', level: 'error', source: 'server', created_at: '2026-10-22T17:00:02.000Z', message: `FUNCTION_ERROR: ${FORGE}`,
      data: { code: 'FUNCTION_ERROR', stack: `Error: ${FORGE}\n    at handler (\x1b]0;title\x07api/x.js:3:9)` } },
    { id: 'b', level: 'info', source: 'function', created_at: '2026-10-22T17:00:01.000Z', message: 'POST /api/x → 500 (12ms)', data: {} },
  ];
  for (const args of [['logs'], ['logs', '--trace', TRACE]]) {
    const r = await run(args, fx);
    assert.equal(r.status, 0, r.out);
    for (const byte of [0x1b, 0x07, 0x0d]) assert.equal(r.bytes.includes(byte), false, `${args.join(' ')}: no raw 0x${byte.toString(16)}`);
    assert.equal(/[\u2028\u2029\u202a-\u202e]/.test(r.out), false, `${args.join(' ')}: no raw separators or bidi overrides`);
    const records = r.out.split('\n').filter((line) => /^  \[\w+\]/.test(line));
    assert.equal(records.length, 2, `${args.join(' ')}: exactly one record line per stored row:\n${r.out}`);
    assert.equal(r.out.includes('\n  [info]  10:00:00 AM  FORGED'), false, 'no forged row');
    assert.match(r.out, /ok\\n  \[info\]  10:00:00 AM  FORGED login succeeded\\r\\x1b\[2J/, 'the forged text is shown escaped, inside its own row');
  }
  const json = await run(['logs', '--json'], fx);
  const parsed = json.out.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(parsed.find((row) => row.id === 'a').message, `FUNCTION_ERROR: ${FORGE}`, '--json keeps the stored text exactly');
  assert.equal(json.bytes.includes(0x1b), false, 'JSON escapes ESC');

  errorRows = [{ endpoint: '/api/x', method: 'POST', status_code: 500, error_code: 'FUNCTION_ERROR', error_message: FORGE, kind: 'exception', source: 'function', created_at: new Date().toISOString() }];
  const errors = await run(['errors'], fx);
  assert.equal(errors.status, 0, errors.out);
  for (const byte of [0x1b, 0x07, 0x0d]) assert.equal(errors.bytes.includes(byte), false, `errors: no raw 0x${byte.toString(16)}`);
  assert.equal(errors.out.includes('\n  [info]'), false, 'errors: no forged row');
});
