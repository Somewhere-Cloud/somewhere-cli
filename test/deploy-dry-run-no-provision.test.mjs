import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// pfb_a0af8bb647dc: a dry run never provisions. Without a credential that can
// already open an existing project it stops before any request: no
// proof-of-work mint, no project create, no link, no config written. A linked
// folder with a usable credential still gets the server's diff.
const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const requests = [];
const dryRunData = {
  current_version: 3,
  static_files: { added: [], modified: ['index.html'], removed: [], added_count: 0, modified_count: 1, removed_count: 0 },
  functions: null,
};
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
    requests.push({ method: req.method, url: req.url, body: parsed });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v1/deploy' && parsed?.dry_run === true) {
      res.end(JSON.stringify({ ok: true, data: dryRunData }));
      return;
    }
    if (req.method === 'GET' && req.url.includes('/notices')) {
      res.end(JSON.stringify({ ok: true, data: { notices: [] } }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: 'UNEXPECTED', message: `${req.method} ${req.url}` }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}/v1`;
test.after(() => server.close());

function run(args, cwd, configDir) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: {
        ...process.env,
        SOMEWHERE_API_URL: apiUrl,
        SOMEWHERE_CONFIG_DIR: configDir,
        SOMEWHERE_MCP_URL: 'http://127.0.0.1:1/mcp',
        CI: '1',
        SOMEWHERE_NO_NOTIFICATIONS: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr, all: stdout + stderr }));
  });
}

function fixture({ config, link } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sw-dry-run-'));
  const configDir = join(root, 'config');
  const app = join(root, 'app');
  mkdirSync(configDir);
  mkdirSync(app);
  if (config) writeFileSync(join(configDir, 'config.json'), JSON.stringify(config));
  writeFileSync(join(app, 'index.html'), '<html><body>hi</body></html>\n');
  // An unreferenced root note, so the once-per-project notice would fire.
  writeFileSync(join(app, 'NOTES.md'), 'scratch\n');
  if (link) writeFileSync(join(app, '.somewhere.json'), JSON.stringify(link));
  return { app, configDir };
}

// Every command, typecheck included, records its own exit in the config dir's
// last-run.json (src/lib/last-run.ts): a local diagnostic, not auth or project
// state. Everything else there (config.json, any temporary session) is compared.
const snapshot = (dir) => Object.fromEntries(
  readdirSync(dir).filter((name) => name !== 'last-run.json').sort()
    .map((name) => [name, readFileSync(join(dir, name), 'utf8')]),
);

const liveTemp = {
  token: 'smt_live_temp',
  temporary: true,
  temp_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  claim_url: 'https://somewhere.cloud/claim?token=swtc_live',
  user: { email: '', username: '' },
};
const signedIn = { token: 'smt_account', user: { email: 'u@example.com', username: 'u' } };
const link = { project_id: 'proj_linked', name: 'linked', subdomain: 'linked' };

function assertRefusedWithoutSideEffects(r, { app, configDir }, before) {
  assert.equal(r.status, 1, r.all);
  assert.deepEqual(requests, [], 'no request reaches the platform');
  assert.deepEqual(snapshot(configDir), before.config, 'the CLI config is unchanged');
  assert.deepEqual(snapshot(app), before.app, 'no .somewhere.json or other file is written');
}

for (const [label, setup] of [
  ['signed out, unlinked folder', {}],
  ['signed out, linked folder (a new temporary account could not open it)', { link }],
  ['live temporary session, unlinked folder', { config: liveTemp }],
]) {
  test(`deploy --dry-run, ${label}: refuses before any request and writes nothing`, async () => {
    requests.length = 0;
    const fx = fixture(setup);
    const before = { config: snapshot(fx.configDir), app: snapshot(fx.app) };
    const r = await run(['deploy', '--dry-run'], fx.app, fx.configDir);
    assertRefusedWithoutSideEffects(r, fx, before);
    assert.match(r.stderr, /Nothing was created, no temporary workspace was started, and no project or login files were changed\./);
    assert.match(r.stderr, /`somewhere typecheck` and `somewhere lint`/);
    assert.doesNotMatch(r.all, /deploy-check|proof-of-work|Claim URL|nothing was deployed/i);
  });
}

test('deploy --dry-run --json, signed out: structured refusal, no request, nothing written', async () => {
  requests.length = 0;
  const fx = fixture();
  const before = { config: snapshot(fx.configDir), app: snapshot(fx.app) };
  const r = await run(['deploy', '--dry-run', '--json'], fx.app, fx.configDir);
  assertRefusedWithoutSideEffects(r, fx, before);
  assert.equal(JSON.parse(r.stdout).error, 'DRY_RUN_NEEDS_PROJECT');
});

test('deploy --dry-run, signed in and linked: sends the documented dry run and leaves .somewhere.json as it was', async () => {
  requests.length = 0;
  const fx = fixture({ config: signedIn, link });
  const before = { config: snapshot(fx.configDir), app: snapshot(fx.app) };
  const r = await run(['deploy', '--dry-run'], fx.app, fx.configDir);
  assert.equal(r.status, 0, r.all);
  const deploys = requests.filter((q) => q.url === '/v1/deploy');
  assert.equal(deploys.length, 1);
  assert.equal(deploys[0].body.dry_run, true);
  assert.equal(deploys[0].body.project_id, 'proj_linked');
  assert.ok(!requests.some((q) => q.method === 'POST' && q.url !== '/v1/deploy'), 'no project create, mint or other write');
  assert.match(r.all, /Dry run.*nothing was deployed/);
  assert.match(r.all, /Not published \(1\): NOTES\.md/);
  assert.deepEqual(snapshot(fx.app), before.app, 'the publish notice is not remembered by a dry run');
  assert.deepEqual(snapshot(fx.configDir), before.config);
});

test('deploy --dry-run, live temporary session and linked folder: dry run only, no claim handoff', async () => {
  requests.length = 0;
  const fx = fixture({ config: liveTemp, link });
  const before = { config: snapshot(fx.configDir), app: snapshot(fx.app) };
  const r = await run(['deploy', '--dry-run'], fx.app, fx.configDir);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(
    requests.filter((q) => q.method !== 'GET').map((q) => `${q.method} ${q.url}`),
    ['POST /v1/deploy'],
    'the only write-shaped request is the dry run itself',
  );
  assert.equal(requests.find((q) => q.url === '/v1/deploy').body.dry_run, true);
  assert.deepEqual(snapshot(fx.app), before.app);
  assert.deepEqual(snapshot(fx.configDir), before.config);
  assert.ok(existsSync(join(fx.app, '.somewhere.json')));
});
