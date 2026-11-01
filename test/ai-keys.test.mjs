import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `somewhere ai keys` (tsk_c91717a5) run as the real CLI against a local
// stand-in for /v1/ai/provider-keys. Replies copy worker/src/routes/
// ai-provider-keys.ts (somewhere-tech #1261). The key is fake; after every run
// no output and no file the CLI could have written may hold it.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../bin/somewhere.js');
const KEY = 'sk-ant-fixture-NOT-A-REAL-KEY-7f3a9c';
const PROJECT = 'proj_fixture_1';

let reply = () => ({ status: 200, body: { ok: true, data: {} } });
let requests = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  // A local port poller on some hosts sends a bare GET /; it is not the CLI.
  if (req.url === '/') { res.writeHead(404); res.end(); return; }
  const entry = { method: req.method, url: req.url, auth: req.headers.authorization ?? null, body: raw ? JSON.parse(raw) : undefined };
  requests.push(entry);
  const { status, body } = reply(entry);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());
const local = () => `http://127.0.0.1:${server.address().port}`;

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

function run(args, { stdin } = {}) {
  requests = [];
  const base = mkdtempSync(join(tmpdir(), 'sw-ai-keys-'));
  const configDir = join(base, 'config');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ token: 'smt_fixture_access', user: { email: 'dev@example.test', username: 'dev' } }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: base,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: {
        ...process.env, HOME: base, USERPROFILE: base, SOMEWHERE_CONFIG_DIR: configDir,
        SOMEWHERE_API_URL: `${local()}/v1`, SOMEWHERE_MCP_URL: `${local()}/mcp`, SOMEWHERE_RUNNER_URL: local(),
        SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
      },
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v);
    child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => {
      const files = filesUnder(base).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
      resolve({ status, stdout, stderr, out: stdout + stderr, files, requests });
    });
  });
}

function assertKeyNowhere(result) {
  assert.ok(!result.out.includes(KEY), `key in output:\n${result.out}`);
  for (const file of result.files) assert.ok(!file.text.includes(KEY), `key persisted in ${file.path}`);
  // No fragment either: a truncated echo is still a leak.
  assert.ok(!result.out.includes(KEY.slice(0, 16)), 'key prefix in output');
}

test('ai keys lists providers and times from GET /v1/ai/provider-keys, never a key', async () => {
  reply = () => ({ status: 200, body: { ok: true, data: { project_id: PROJECT, keys: [
    { provider: 'anthropic', updated_at: '2026-10-31T12:00:00.000Z' },
    { provider: 'openai', updated_at: '2026-10-30T08:00:00.000Z' },
  ] } } });
  for (const args of [['ai', 'keys', '--project', PROJECT], ['ai', 'keys', 'list', '--project', PROJECT], ['ai', 'keys', 'ls', '--project', PROJECT]]) {
    const result = await run(args);
    assert.equal(result.status, 0, result.out);
    assert.deepEqual(result.requests.map((r) => `${r.method} ${r.url}`), [`GET /v1/ai/provider-keys?project_id=${PROJECT}`]);
    assert.equal(result.requests[0].auth, 'Bearer smt_fixture_access');
    assert.match(result.stdout, /anthropic\s+set 2026-10-31T12:00:00.000Z/);
    assert.match(result.stdout, /openai\s+set 2026-10-30T08:00:00.000Z/);
  }
  const json = await run(['ai', 'keys', '--project', PROJECT, '--json']);
  assert.equal(json.status, 0, json.out);
  assert.deepEqual(JSON.parse(json.stdout).keys.map((k) => k.provider), ['anthropic', 'openai']);
});

test('ai keys with none set says so and names the set command', async () => {
  reply = () => ({ status: 200, body: { ok: true, data: { project_id: PROJECT, keys: [] } } });
  const result = await run(['ai', 'keys', '--project', PROJECT]);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /No AI provider keys set for this project/);
  assert.match(result.out, new RegExp(`somewhere ai keys set anthropic --project ${PROJECT}`));
});

test('every ai keys command needs an explicit --project and sends nothing without it', async () => {
  for (const [args, stdin] of [[['ai', 'keys']], [['ai', 'keys', 'set', 'anthropic', '--stdin'], KEY], [['ai', 'keys', 'remove', 'openai']]]) {
    const result = await run(args, { stdin });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /Pass --project <id>/);
    assert.deepEqual(result.requests, []);
    assertKeyNowhere(result);
  }
});

test('set --stdin posts { project_id, provider, key } once and the key appears in no output or file', async () => {
  reply = (r) => ({ status: 201, body: { ok: true, data: { project_id: r.body.project_id, provider: r.body.provider, set: true } } });
  const result = await run(['ai', 'keys', 'set', 'anthropic', '--project', PROJECT, '--stdin'], { stdin: `${KEY}\n` });
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(result.requests.map((r) => `${r.method} ${r.url}`), ['POST /v1/ai/provider-keys']);
  assert.deepEqual(result.requests[0].body, { project_id: PROJECT, provider: 'anthropic', key: KEY });
  assert.ok(result.out.includes(`Anthropic key saved for ${PROJECT}. sw.ai completions that name an Anthropic model or provider use it from the next call; no redeploy is needed.`), result.out);
  assertKeyNowhere(result);
  const lastRun = result.files.find((f) => f.path.endsWith('last-run.json'));
  assert.ok(lastRun, 'last-run.json written');
  // Option names only (never values); --project may be counted on the parent `keys`.
  assert.ok(JSON.parse(lastRun.text).options.includes('--stdin'));
  assert.equal(JSON.parse(lastRun.text).command, 'ai keys set');

  const json = await run(['ai', 'keys', 'set', 'openai', '--project', PROJECT, '--stdin', '--json'], { stdin: KEY });
  assert.equal(json.status, 0, json.out);
  assert.deepEqual(JSON.parse(json.stdout), { project_id: PROJECT, provider: 'openai', set: true });
  assertKeyNowhere(json);
});

test('set refuses a key on the command line without repeating it and sends nothing', async () => {
  for (const args of [
    ['ai', 'keys', 'set', 'anthropic', KEY, '--project', PROJECT],
    ['ai', 'keys', 'set', 'anthropic', `--key=${KEY}`, '--project', PROJECT],
    ['ai', 'keys', 'set', 'anthropic', '--key', KEY, '--project', PROJECT, '--stdin'],
  ]) {
    const result = await run(args, { stdin: args.includes('--stdin') ? 'sk-other' : undefined });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /takes only the provider/);
    assert.match(result.out, /replace that key/);
    assert.deepEqual(result.requests, []);
    assertKeyNowhere(result);
  }
  const wrongSlot = await run(['ai', 'keys', 'set', KEY, '--project', PROJECT, '--stdin'], { stdin: 'x' });
  assert.equal(wrongSlot.status, 1, wrongSlot.out);
  assert.match(wrongSlot.out, /provider must be anthropic or openai/);
  assert.deepEqual(wrongSlot.requests, []);
  assertKeyNowhere(wrongSlot);
});

test('set without a terminal needs --stdin; empty or multi-line input is refused before any request', async () => {
  const noTty = await run(['ai', 'keys', 'set', 'anthropic', '--project', PROJECT]);
  assert.equal(noTty.status, 1, noTty.out);
  assert.match(noTty.out, /Pass --stdin to read the key from a pipe/);
  assert.deepEqual(noTty.requests, []);
  for (const stdin of ['', '  \n', `${KEY}\nsecond-line\n`, `${KEY} \n`, 'k'.repeat(4097)]) {
    const result = await run(['ai', 'keys', 'set', 'anthropic', '--project', PROJECT, '--stdin'], { stdin });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /Nothing was sent/);
    assert.deepEqual(result.requests, []);
    assertKeyNowhere(result);
  }
});

test('server refusals are shown in the platform words; the key is in no output, error record or file', async () => {
  for (const [status, code, message] of [
    [403, 'DEVELOPER_CREDENTIAL_REQUIRED', 'Managing AI provider keys runs only with a developer\'s own sign-in.'],
    [403, 'PROJECT_EDITOR_REQUIRED', 'Editor access is required to set AI provider keys.'],
    [404, 'PROJECT_NOT_FOUND', 'Project not found.'],
    [400, 'VALIDATION_ERROR', 'key max 4096 characters.'],
  ]) {
    reply = () => ({ status, body: { ok: false, error: code, message } });
    const result = await run(['ai', 'keys', 'set', 'anthropic', '--project', PROJECT, '--stdin'], { stdin: KEY });
    assert.equal(result.status, 1, result.out);
    assert.ok(result.out.includes(message), result.out);
    assert.match(result.out, new RegExp(`code ${code}`));
    assert.equal(result.requests.length, 1);
    assertKeyNowhere(result);
    const json = await run(['ai', 'keys', 'set', 'anthropic', '--project', PROJECT, '--stdin', '--json'], { stdin: KEY });
    assert.equal(json.status, 1, json.out);
    assert.equal(JSON.parse(json.stdout).error, code);
    assertKeyNowhere(json);
  }
});

test('remove sends DELETE /v1/ai/provider-keys/:project_id/:provider; a missing key is an error', async () => {
  reply = (r) => ({ status: 200, body: { ok: true, data: { project_id: PROJECT, provider: r.url.split('/').pop(), deleted: true } } });
  for (const verb of ['remove', 'rm']) {
    const result = await run(['ai', 'keys', verb, 'openai', '--project', PROJECT]);
    assert.equal(result.status, 0, result.out);
    assert.deepEqual(result.requests.map((r) => `${r.method} ${r.url}`), [`DELETE /v1/ai/provider-keys/${PROJECT}/openai`]);
    assert.equal(result.requests[0].body, undefined);
    assert.ok(result.out.includes(`OpenAI key removed for ${PROJECT}.`), result.out);
  }
  reply = () => ({ status: 404, body: { ok: false, error: 'NOT_FOUND', message: 'AI provider key not found.' } });
  const missing = await run(['ai', 'keys', 'remove', 'anthropic', '--project', PROJECT]);
  assert.equal(missing.status, 1, missing.out);
  assert.ok(missing.out.includes(`No Anthropic key was set for ${PROJECT}.`), missing.out);
  assert.match(missing.out, /code NOT_FOUND/);
  const missingJson = await run(['ai', 'keys', 'remove', 'anthropic', '--project', PROJECT, '--json']);
  assert.equal(missingJson.status, 1, missingJson.out);
  assert.equal(JSON.parse(missingJson.stdout).error, 'NOT_FOUND');
  const bad = await run(['ai', 'keys', 'remove', 'gemini', '--project', PROJECT]);
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /provider must be anthropic or openai/);
  assert.deepEqual(bad.requests, []);
});

test('before the status read ships, ai keys says status is unavailable, never "no keys"; set and remove do not read it', async () => {
  for (const [status, body] of [
    // Current platform: only POST is defined at /v1/ai/provider-keys.
    [405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'This endpoint accepts POST.', allowed: ['POST'] }],
    [404, { ok: false, error: 'NOT_FOUND', message: 'Endpoint not found.' }],
    [200, { ok: true, data: { project_id: PROJECT } }],
  ]) {
    reply = () => ({ status, body });
    const text = await run(['ai', 'keys', '--project', PROJECT]);
    assert.equal(text.status, 1, text.out);
    assert.match(text.out, /Listing keys needs a newer platform/);
    assert.match(text.out, /set and remove work now/);
    assert.match(text.out, new RegExp(`somewhere ai keys set anthropic --project ${PROJECT}`));
    assert.doesNotMatch(text.out, /No AI provider keys set/);
    const json = await run(['ai', 'keys', 'list', '--project', PROJECT, '--json']);
    assert.equal(json.status, 1, json.out);
    assert.equal(JSON.parse(json.stdout).error, 'AI_KEY_STATUS_UNAVAILABLE');
  }
  // Project and permission refusals keep the platform's own code and words.
  for (const [status, code, message] of [
    [404, 'PROJECT_NOT_FOUND', 'Project not found.'],
    [403, 'DEVELOPER_CREDENTIAL_REQUIRED', 'Managing AI provider keys runs only with a developer\'s own sign-in.'],
  ]) {
    reply = () => ({ status, body: { ok: false, error: code, message } });
    const result = await run(['ai', 'keys', '--project', PROJECT]);
    assert.equal(result.status, 1, result.out);
    assert.ok(result.out.includes(message), result.out);
    assert.doesNotMatch(result.out, /newer platform/);
    const json = await run(['ai', 'keys', '--project', PROJECT, '--json']);
    assert.equal(JSON.parse(json.stdout).error, code);
  }
  // set and remove succeed with no GET at all.
  reply = (r) => r.method === 'GET'
    ? { status: 405, body: { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'This endpoint accepts POST.' } }
    : { status: r.method === 'POST' ? 201 : 200, body: { ok: true, data: { project_id: PROJECT, provider: 'anthropic', ...(r.method === 'POST' ? { set: true } : { deleted: true }) } } };
  const set = await run(['ai', 'keys', 'set', 'anthropic', '--project', PROJECT, '--stdin'], { stdin: KEY });
  assert.equal(set.status, 0, set.out);
  assert.deepEqual(set.requests.map((r) => r.method), ['POST']);
  assertKeyNowhere(set);
  const removed = await run(['ai', 'keys', 'remove', 'anthropic', '--project', PROJECT]);
  assert.equal(removed.status, 0, removed.out);
  assert.deepEqual(removed.requests.map((r) => r.method), ['DELETE']);
});
