import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsk_da2dba3d (Journey tcm_b2713a6e): control-byte escaping alone still let a stack line visually forge a log
// row, because continuation lines were only indented. Every stack continuation now carries one fixed marker,
// so untrusted text can never begin a line or pass as a record at ANY indentation. --json stays exact.
const here = dirname(fileURLToPath(import.meta.url));
const distIndex = join(here, '..', 'dist', 'index.js');
// The fixed marker the CLI must print. Read from the build when it exports it; the literal keeps these tests
// runnable (and failing for the right reason) against an older build such as 0.37.70, which has no marker.
const textModule = await import(join(here, '..', 'dist', 'lib', 'terminal-text.js'));
const CONTINUATION_MARKER = textModule.CONTINUATION_MARKER ?? '      stack | ';
const terminalContinuation = textModule.terminalContinuation;

let logRows = [];
let errorRows = [];
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.setHeader('Content-Type', 'application/json');
  if (/^(?:\/v1)?\/errors\/recent\b/.test(req.url)) return res.end(JSON.stringify({ ok: true, data: { errors: errorRows } }));
  res.end(JSON.stringify({ ok: true, data: { logs: logRows } }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sw-stackmark-'));
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
const TRACE = '84d6a1b2c3d4e5f60718293a4b5c6d7e';
/** A record line at ANY indentation: what a reader (or an agent scanning output) takes for a log row. */
const looksLikeRecord = (line) => /^\s*\[(debug|info|warn|error)\s*\]/i.test(line);
const crash = (stack) => ({ id: 'a', level: 'error', source: 'server', created_at: '2026-10-22T17:00:02.000Z',
  message: 'FUNCTION_ERROR: booking failed', data: { code: 'FUNCTION_ERROR', stack } });
const info = { id: 'b', level: 'info', source: 'function', created_at: '2026-10-22T17:00:01.000Z', message: 'POST /api/x → 500 (12ms)', data: {} };

test('a legitimate multi-line stack stays readable: every frame on its own marked line, CRLF included', async () => {
  const fx = fixture();
  const frames = ['Error: booking failed', '    at handler (api/book.js:12:9)', '    at async run (runtime.js:40:3)'];
  for (const stack of [frames.join('\n'), frames.join('\r\n')]) {
    logRows = [crash(stack), info];
    for (const args of [['logs', '--trace', TRACE]]) {
      const r = await run(args, fx);
      assert.equal(r.status, 0, r.out);
      for (const frame of frames) assert.ok(r.out.includes(`${CONTINUATION_MARKER}${frame}\n`), `${args.join(' ')}: frame shown readable: ${frame}\n${r.out}`);
      assert.equal(r.out.includes('\\r'), false, 'a CRLF stack is not shown with escaped CRs');
    }
  }
});

const FORGED_ROW = '  [info]  10:00:00 AM  FORGED login succeeded';
const HOSTILE = `Error: x\n${FORGED_ROW}\n[error] FORGED at the margin\n\t[warn] FORGED tab-indented\r\n\x1b[2J\x1b]0;title\x07\u009b31mC1\u202ereversed\u2028next\n    at handler (api/x.js:3:9)`;

test('a fake row inside a stack never appears as an independent record, at any indentation', async () => {
  const fx = fixture();
  logRows = [crash(HOSTILE), info];
  for (const args of [['logs'], ['logs', '--trace', TRACE]]) {
    const r = await run(args, fx);
    assert.equal(r.status, 0, r.out);
    const lines = r.out.split('\n');
    assert.equal(lines.filter(looksLikeRecord).length, 2, `${args.join(' ')}: only the two stored rows look like records:\n${r.out}`);
    for (const line of lines.filter((l) => l.includes('FORGED'))) assert.ok(line.startsWith(CONTINUATION_MARKER), `forged text stays under the marker: ${JSON.stringify(line)}`);
    if (!args.includes('--trace')) continue; // the stack itself is shown only for one traced request
    assert.ok(r.out.includes(`${CONTINUATION_MARKER}${FORGED_ROW}\n`), 'the forged text is still shown (as stack content), not dropped');
    assert.ok(r.out.includes(`${CONTINUATION_MARKER}    at handler (api/x.js:3:9)`), 'the real frame after it is kept');
  }
});

test('C0, C1, ESC, CR, separators and bidi overrides in a stack never reach the terminal raw', async () => {
  const fx = fixture();
  logRows = [crash(HOSTILE), info];
  const r = await run(['logs', '--trace', TRACE], fx);
  for (const byte of [0x1b, 0x07, 0x0d, 0x09]) assert.equal(r.bytes.includes(byte), false, `no raw 0x${byte.toString(16)}`);
  assert.equal(/[\u0080-\u009f\u2028\u2029\u202a-\u202e]/.test(r.out), false, 'no raw C1, separators or bidi overrides');
  for (const shown of ['\\x1b[2J', '\\x07', '\\x9b31mC1', '\\u202ereversed', '\\u2028next', '\\t[warn]']) assert.ok(r.out.includes(shown), `escaped: ${shown}`);
});

test('a long stack is counted, not silently cut; --json keeps the whole stack exactly', async () => {
  const fx = fixture();
  const long = ['Error: deep', ...Array.from({ length: 40 }, (_, i) => `    at f${i} (api/x.js:${i}:1)`)].join('\n');
  logRows = [crash(long), info];
  const r = await run(['logs', '--trace', TRACE], fx);
  assert.ok(r.out.includes(`${CONTINUATION_MARKER}    at f28 (api/x.js:28:1)`), 'the first 30 lines are shown');
  assert.equal(r.out.includes('at f29 '), false);
  assert.ok(r.out.includes(`${CONTINUATION_MARKER}... 11 more lines (--json shows the whole stack)`), r.out);
  logRows = [crash(HOSTILE), info];
  const json = await run(['logs', '--json'], fx);
  const parsed = json.out.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(parsed.find((row) => row.id === 'a').data.stack, HOSTILE, '--json keeps the stored stack byte for byte');
  assert.equal(json.out.includes(CONTINUATION_MARKER), false, 'no marker in JSON');
});

test('errors text: a message carrying a fake row stays one line per record', async () => {
  const fx = fixture();
  const row = (message) => ({ endpoint: '/api/x', method: 'POST', status_code: 500, error_code: 'FUNCTION_ERROR', error_message: message, kind: 'exception', source: 'function', created_at: new Date().toISOString() });
  // The fake row within the first 80 characters, so it is not simply cut by the message truncation.
  errorRows = [row(`x\n${FORGED_ROW}`)];
  let r = await run(['errors'], fx);
  assert.equal(r.status, 0, r.out);
  let lines = r.out.split('\n');
  assert.match(r.out, /POST \/api\/x/, `the error row is actually rendered (not an empty window):\n${r.out}`);
  assert.equal(lines.filter(looksLikeRecord).length, 0, `no line looks like a log record:\n${r.out}`);
  assert.equal(lines.filter((l) => l.includes('FORGED')).length, 1, `the fake row stays inside its one record line:\n${r.out}`);
  assert.match(r.out, /\n  exception +500 +POST \/api\/x +x\\n \[info\] 10:00:00 AM FORGED login succeeded /, 'shown escaped, inside its own table row');
  errorRows = [row(HOSTILE)];
  r = await run(['errors'], fx);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.split('\n').filter(looksLikeRecord).length, 0);
  for (const byte of [0x1b, 0x07, 0x0d, 0x09]) assert.equal(r.bytes.includes(byte), false, `errors: no raw 0x${byte.toString(16)}`);
});

test('the continuation renderer: one fixed marker on every line, nothing else can start a line', () => {
  assert.equal(typeof terminalContinuation, 'function', 'the build exports terminalContinuation');
  assert.equal(textModule.CONTINUATION_MARKER, '      stack | ', 'the exported marker is the fixed literal');
  assert.deepEqual(terminalContinuation(''), []);
  assert.deepEqual(terminalContinuation(null), []);
  const out = terminalContinuation('a\r\nb\n\nc\u2028d', 30);
  assert.deepEqual(out, [`${CONTINUATION_MARKER}a`, `${CONTINUATION_MARKER}b`, CONTINUATION_MARKER, `${CONTINUATION_MARKER}c\\u2028d`]);
  for (const line of terminalContinuation(HOSTILE)) {
    assert.ok(line.startsWith(CONTINUATION_MARKER));
    assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(line), false, JSON.stringify(line));
  }
});
