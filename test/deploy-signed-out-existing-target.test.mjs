import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// pfb_e653dbb1fa74: with no stored credential, a deploy that names an existing
// project (--project or a folder link) cannot use a fresh temporary account,
// which owns no project. It is refused before anything is minted or sent.
// Legitimate paths keep working: a first unlinked anonymous deploy, and a live
// cached temporary session redeploying its own linked project without minting.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const requests = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = req.url.split('?')[0];
    if (path === '/') return res.end(); // this machine's local-port poller
    requests.push({ method: req.method, path, auth: req.headers.authorization ?? null });
    const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    const expires = new Date(Date.now() + 3 * 3600e3).toISOString();
    if (path === '/v1/auth/pow/challenge') return json(200, { ok: true, data: { nonce: 'tmpc_1', difficulty: 1, algorithm: 'sha256', input: 'tmpc_1:<suffix>', expires_at: expires, ttl_seconds: 600 } });
    if (path === '/v1/auth/temp-create') return json(200, { ok: true, data: { key: 'smt_tmp_new', access_token: 'smt_tmp_new', scopes: [], expires_at: expires, ttl_seconds: 10800, claim_token: 'swtc_new', claim_url: 'https://somewhere.cloud/claim?token=swtc_new' } });
    if (req.method === 'POST' && path === '/v1/projects') return json(200, { ok: true, data: { id: 'proj_tmp_new', name: 'app-x1', subdomain: 'app-x1', slug: 'app-x1' } });
    if (path === '/v1/auth/temp-handoff/register') return json(201, { ok: true, data: { handoff_id: 'cch_1', expires_at: expires } });
    if (req.method === 'POST' && path === '/v1/deploy') {
      // A temporary account can deploy only to a project it owns.
      const owned = { 'Bearer smt_tmp_new': 'proj_tmp_new', 'Bearer smt_tmp_cached': 'proj_tmp_cached' }[req.headers.authorization];
      const target = JSON.parse(body).project_id;
      if (target !== owned) return json(404, { ok: false, error: 'PROJECT_NOT_FOUND', message: 'Project not found.' });
      return json(200, { ok: true, data: { files: 1, url: `https://${target}.somewhere.site`, version: 2, release_id: 'rel_2', has_functions: false, warnings: [] } });
    }
    json(200, { ok: true, data: { notices: [] } });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

function run(args, { link, config } = {}) {
  requests.length = 0;
  const base = mkdtempSync(join(tmpdir(), 'sw-signed-out-'));
  const app = join(base, 'app'), cfg = join(base, 'config');
  mkdirSync(app); mkdirSync(cfg);
  writeFileSync(join(app, 'index.html'), '<html><body>hi</body></html>\n');
  if (link) writeFileSync(join(app, '.somewhere.json'), JSON.stringify(link));
  if (config) writeFileSync(join(cfg, 'config.json'), JSON.stringify(config));
  const url = `http://127.0.0.1:${server.address().port}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, SOMEWHERE_CONFIG_DIR: cfg, SOMEWHERE_API_URL: `${url}/v1`, SOMEWHERE_MCP_URL: `${url}/mcp`, SOMEWHERE_RUNNER_URL: url,
      SOMEWHERE_TOKEN: '', SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr }));
  });
}

for (const [label, args, link] of [
  ['--project', ['deploy', '--project', 'proj_existing'], undefined],
  ['a folder link', ['deploy'], { project_id: 'proj_linked', name: 'Linked', subdomain: 'linked' }],
  ['--project with --scope functions', ['deploy', '--project', 'proj_existing', '--scope', 'functions'], undefined],
]) {
  test(`signed out, ${label}: refused before any request, nothing minted`, async () => {
    const result = await run(args, { link });
    assert.equal(result.status, 1, result.out);
    assert.deepEqual(requests, [], 'no proof-of-work, no temporary account, no deploy');
    assert.match(result.out, /not signed in, and a new temporary workspace cannot deploy to an existing project\. Nothing was created or sent\./);
    assert.match(result.out, /somewhere login/);
    assert.match(result.out, /somewhere auth set/);
  });
}

test('signed out, --json: structured SIGN_IN_REQUIRED, nothing sent', async () => {
  const result = await run(['deploy', '--json'], { link: { project_id: 'proj_linked', name: 'Linked', subdomain: 'linked' } });
  assert.equal(result.status, 1);
  const out = JSON.parse(result.stdout);
  assert.equal(out.error, 'SIGN_IN_REQUIRED');
  assert.equal(out.project_id, 'proj_linked');
  assert.deepEqual(requests, []);
});

test('signed out, unlinked: the first anonymous deploy still mints and goes live', async () => {
  const result = await run(['deploy', '--json']);
  assert.equal(result.status, 0, result.out);
  assert.equal(JSON.parse(result.stdout).url, 'https://proj_tmp_new.somewhere.site');
  assert.deepEqual(requests.filter((r) => r.path.startsWith('/v1/auth/')).map((r) => r.path).slice(0, 2), ['/v1/auth/pow/challenge', '/v1/auth/temp-create']);
});

test('a live cached temporary session redeploys its own linked project without minting', async () => {
  const result = await run(['deploy', '--json'], {
    link: { project_id: 'proj_tmp_cached', name: 'Cached', subdomain: 'cached' },
    config: { token: 'smt_tmp_cached', temporary: true, temp_expires_at: new Date(Date.now() + 3600e3).toISOString(), claim_url: 'https://somewhere.cloud/claim?token=swtc_c', user: { email: '', username: '' } },
  });
  assert.equal(result.status, 0, result.out);
  assert.equal(JSON.parse(result.stdout).url, 'https://proj_tmp_cached.somewhere.site');
  assert.ok(!requests.some((r) => r.path.startsWith('/v1/auth/pow')), 'no new temporary account');
});
