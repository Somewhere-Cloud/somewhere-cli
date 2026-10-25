// tsk_da2dba3d: optional checks cannot erase a confirmed live deploy.
// Real CLI transport against loopback only; no account, browser or deploy on the platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const live = {
  project_id: 'proj_verify_outcome', version: 73,
  release_id: 'rel_live_73', active_release_id: 'rel_live_73',
  files: 1, has_functions: false, url: 'https://verify-outcome.somewhere.tech',
  reference_check: { status: 'pending' }, warnings: ['existing advisory'],
};
async function fixture({ mode = 'failed', json = true, flow, temporary = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'sw-deploy-check-outcome-'));
  const dir = join(scratch, 'source');
  const configDir = join(scratch, 'config');
  mkdirSync(dir); mkdirSync(configDir);
  const config = { token: 'smt_synthetic_outcome', user: { email: 'synthetic@example.test', username: 'synthetic' },
    ...(temporary ? { temporary: true, claim_url: 'https://somewhere.tech/claim?token=synthetic' } : {}) };
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(config));
  const initial = { project_id: live.project_id, name: 'verification-outcome', subdomain: 'verify-outcome',
    source_base: { project_id: live.project_id, release_id: 'rel_before', at: '2026-10-24T00:00:00.000Z' } };
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify(initial));
  writeFileSync(join(dir, 'index.html'), '<html><body>synthetic</body></html>');
  if (flow === 'invalid') writeFileSync(join(dir, 'flow.json'), '{');
  const requests = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`);
      const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method === 'GET') return send({ ok: true, data: { ...live, notices: [] } });
      if (req.url === '/v1/deploy') {
        if (mode === 'unknown') { req.socket.destroy(); return; }
        if (mode === 'prelive') return send({ ok: false, error: 'BUILD_FAILED', message: 'Synthetic compile failure.', retry: false }, 400);
        return send({ ok: true, data: live });
      }
      if (req.url === '/v1/browser/test') {
        if (mode === 'transport') { req.socket.destroy(); return; }
        if (mode === 'malformed') return send({ ok: true, data: { dialogs: { private: 'PRIVATE_DIAGNOSTIC_SENTINEL' } } });
        return send({ ok: true, data: { steps: [], console: [], errors: [], requests: [], duration_ms: 1,
          ...(mode === 'passed' ? { screenshots: ['https://example.test/synthetic.png'] } : {}) } });
      }
      // Old temporary sessions may check claim state; they must never mint.
      return send({ ok: false, error: 'NOT_FOUND', message: 'Synthetic fixture.' }, 404);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const args = ['deploy', '--verify', ...(flow ? [flow === 'missing' ? 'missing.json' : 'flow.json'] : []), ...(json ? ['--json'] : [])];
  let result;
  try {
    result = await new Promise(resolve => {
      const child = spawn(process.execPath, [join(root, 'dist/index.js'), ...args], { cwd: dir, env: {
        ...process.env, SOMEWHERE_CONFIG_DIR: configDir,
        SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1',
      } });
      let stdout = '', stderr = '';
      child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
      child.on('close', status => resolve({ status, stdout, stderr }));
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
  return { ...result, requests, initial, state: JSON.parse(readFileSync(join(dir, '.somewhere.json'), 'utf8')),
    account: JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) };
}
for (const flow of ['missing', 'invalid']) test(`invalid local ${flow} flow is rejected before any HTTP mutation`, async () => {
  const result = await fixture({ flow });
  assert.equal(result.status, 1); assert.deepEqual(result.requests, []);
  assert.deepEqual(result.state, result.initial);
  assert.equal(JSON.parse(result.stdout).error, 'CLI_ERROR');
});
for (const mode of ['failed', 'transport', 'malformed']) for (const json of [false, true]) {
  test(`live deploy plus ${mode} verification preserves outcome and anchor (${json ? 'JSON' : 'text'})`, async () => {
    const result = await fixture({ mode, json });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.requests.filter(r => r === 'POST /v1/deploy').length, 1);
    assert.equal(result.state.source_base.release_id, live.release_id);
    assert.equal(result.state.last_deploy.last_deployed_version, live.version);
    assert.equal(result.state.last_deploy.release_id, live.release_id);
    assert.doesNotMatch(result.stdout + result.stderr, /Deploy failed|PRIVATE_DIAGNOSTIC_SENTINEL|--force|run `somewhere deploy`/);
    if (json) {
      const output = JSON.parse(result.stdout);
      for (const [key, value] of Object.entries(live)) assert.deepEqual(output[key], value, key);
      assert.equal(output.deployment_outcome, 'live');
      if (mode === 'malformed') assert.deepEqual(Object.keys(output.verification_error).sort(), ['code', 'message']);
      else assert.equal(output.verification.passed, false);
      if (mode === 'transport') assert.equal(output.verification.transport_errors.length, 2);
      assert.match(output.next_steps.join('\n'), /somewhere status --project <PROJECT>/);
      assert.match(output.next_steps.join('\n'), /somewhere verify --project <PROJECT>/);
    } else {
      assert.match(result.stdout, /Live at https:\/\/verify-outcome.somewhere.tech/);
      assert.match(result.stdout, /The deploy is live, but verification/);
      assert.match(result.stdout, /somewhere verify --project <PROJECT>/);
    }
  });
}
test('pre-publication refusal never updates the local release anchor', async () => {
  const result = await fixture({ mode: 'prelive' });
  assert.equal(result.status, 1); assert.deepEqual(result.state, result.initial);
  assert.deepEqual(result.requests.filter(r => r.startsWith('POST')), ['POST /v1/deploy']);
  const output = JSON.parse(result.stdout);
  assert.equal(output.error, 'BUILD_FAILED'); assert.equal(output.retry, false);
  assert.equal(output.deployment_outcome, undefined);
});
test('existing temporary session keeps claim fields and ownership while failed check saves its source base', async () => {
  const result = await fixture({ temporary: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.claim_url, 'https://somewhere.tech/claim?token=synthetic');
  assert.equal(output.version, live.version); assert.equal(output.deployment_outcome, 'live');
  assert.equal(result.state.source_base.release_id, live.release_id);
  assert.equal(result.state.last_deploy, undefined, 'temporary sessions retain their existing deploy-state policy');
  assert.equal(result.account.token, 'smt_synthetic_outcome'); assert.equal(result.account.temporary, true);
  assert.equal(result.requests.some(r => /POST \/v1\/auth\/temp$|POST \/v1\/projects$/.test(r)), false, result.requests.join('\n'));
});

test('unknown deployment transport outcome never saves or claims a live release', async () => {
  const result = await fixture({ mode: 'unknown' });
  assert.equal(result.status, 1); assert.deepEqual(result.state, result.initial);
  const output = JSON.parse(result.stdout);
  assert.equal(output.error, 'NETWORK_ERROR'); assert.equal(output.deployment_outcome, undefined);
  assert.equal(result.requests.some(r => r === 'POST /v1/browser/test'), false);
});
for (const json of [false, true]) test(`passing verification keeps its success exit (${json ? 'JSON' : 'text'})`, async () => {
  const result = await fixture({ mode: 'passed', json });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.state.source_base.release_id, live.release_id);
  assert.equal(result.state.last_deploy.last_deployed_version, live.version);
  if (json) {
    const output = JSON.parse(result.stdout);
    assert.equal(output.verification.passed, true); assert.equal(output.deployment_outcome, 'live');
    assert.equal(output.next_steps, undefined); assert.equal(output.verification_error, undefined);
  } else assert.doesNotMatch(result.stdout, /The deploy is live, but verification/);
});
