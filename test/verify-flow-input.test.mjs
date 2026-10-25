import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVerifyFlow, loadVerifyInput, normalizeVerifyFlow, normalizeVerifyJourney, verifyFlowSchema } from '../dist/commands/verify.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const marker = 'PRIVATE_FLOW_MARKER_smt_fixture';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sw-verify-input-'));
  const configDir = join(root, 'config');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ token: 'smt_fixture' }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { cwd: root, env: { ...process.env, SOMEWHERE_CONFIG_DIR: configDir, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', NO_COLOR: '1' } };
}

test('verify and deploy processes distinguish local file failures without emitting file content or paths', (t) => {
  const opts = fixture(t);
  const malformed = `private-${marker}\x1b[31m.json`;
  writeFileSync(join(opts.cwd, malformed), `${marker}\x1b[31m{"headers":{"Authorization":"secret"}`);
  mkdirSync(join(opts.cwd, 'directory.json'));
  const failures = [
    [`missing-${marker}\x1b[31m.json`, 'Flow file not found.', /existing JSON file/],
    ['directory.json', 'Flow file could not be read.', /readable JSON file; check its file permissions/],
    [malformed, 'Flow file is not valid JSON.', /Fix the JSON/],
  ];
  if (process.getuid?.() !== 0) {
    writeFileSync(join(opts.cwd, 'unreadable.json'), '{}');
    chmodSync(join(opts.cwd, 'unreadable.json'), 0o000);
    failures.push(['unreadable.json', 'Flow file could not be read.', /readable JSON file; check its file permissions/]);
  }
  for (const [file, reason, next] of failures) {
    for (const [args, flag] of [
      [['verify', '--url', 'http://127.0.0.1:65534', '--flow', file], '--flow'],
      [['deploy', '--verify', file], '--verify'],
    ]) {
      for (const json of [false, true]) {
        const result = spawnSync(process.execPath, [cli, ...args, ...(json ? ['--json'] : [])], { ...opts, encoding: 'utf8' });
        const output = result.stdout + result.stderr;
        assert.equal(result.status, 1, output);
        const message = json ? JSON.parse(result.stdout).message : result.stderr;
        if (json) assert.equal(JSON.parse(result.stdout).error, 'CLI_ERROR');
        assert.ok(message.includes(reason), message);
        assert.ok(message.includes(flag), message);
        assert.match(message, next);
        assert.match(message, /somewhere verify --schema/);
        assert.doesNotMatch(output, /PRIVATE_FLOW_MARKER|Authorization|secret|\x1b|Unexpected token|position \d/);
        assert.ok(!output.includes(opts.cwd), output);
      }
    }
  }
});

test('valid flows, journeys, default health checks and action validation keep their existing contract', (t) => {
  const { cwd } = fixture(t);
  const raw = { actions: [{ click: '#save' }], viewports: ['desktop'] };
  writeFileSync(join(cwd, 'single.json'), JSON.stringify(raw));
  assert.deepEqual(loadVerifyFlow('single.json', cwd), normalizeVerifyFlow(raw, cwd));
  assert.deepEqual(loadVerifyInput('single.json', cwd), { kind: 'single', flow: normalizeVerifyFlow(raw, cwd) });
  assert.deepEqual(loadVerifyFlow(undefined, cwd), normalizeVerifyFlow(undefined));
  assert.deepEqual(loadVerifyInput(undefined, cwd), { kind: 'single', flow: normalizeVerifyFlow(undefined) });
  const journey = { actors: { alice: {} }, journey: [{ as: 'alice', actions: [{ click: '#save' }] }] };
  writeFileSync(join(cwd, 'journey.json'), JSON.stringify(journey));
  assert.deepEqual(loadVerifyInput('journey.json', cwd), { kind: 'journey', journey: normalizeVerifyJourney(journey, cwd) });
  assert.throws(() => loadVerifyFlow('journey.json', cwd), /This is a multi-user flow/);
  writeFileSync(join(cwd, 'invalid-action.json'), JSON.stringify({ actions: [{ click: '#save', fill: '#name', value: 'x' }] }));
  for (const load of [loadVerifyFlow, loadVerifyInput]) {
    assert.throws(() => load('invalid-action.json', cwd), /exactly one/);
  }
});

test('verify schema bypass and a valid process flow remain unchanged', async (t) => {
  const opts = fixture(t);
  const schema = spawnSync(process.execPath, [cli, 'verify', '--schema', '--flow', 'missing.json'], { ...opts, encoding: 'utf8' });
  assert.equal(schema.status, 0, schema.stderr);
  assert.deepEqual(JSON.parse(schema.stdout), verifyFlowSchema());
  const raw = { actions: [{ click: '#save' }], viewports: ['desktop'] };
  writeFileSync(join(opts.cwd, 'flow.json'), JSON.stringify(raw));
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, data: {
        passed: true, final_url: 'https://fixture.somewhere.site/',
        steps: [{ step: 0, action: 'click', ok: true }],
        console_errors: [], page_errors: [], failed_requests: [], request_expectations: [],
        screenshots: [{ path: '/fixture.jpg' }],
      } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, 'verify', '--project', 'fixture', '--flow', 'flow.json', '--json'], {
        ...opts, env: { ...opts.env, SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1` },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].path, '/v1/browser/test');
    assert.equal(requests[0].body.project_id, 'fixture');
    assert.deepEqual(requests[0].body.actions, raw.actions);
    assert.equal(requests[0].body.viewport, 'desktop');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
