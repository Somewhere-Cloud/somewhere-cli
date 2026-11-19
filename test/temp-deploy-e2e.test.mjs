import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This is a LOCAL e2e against a stub server — the real backend
// (lane/worker-tempdeploy) is not deployed. Never point this at
// api.somewhere.cloud.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');


// --- Stub /v1 API: temp-create, projects, deploy. -----------
let tempCreateCalls = 0;
let projectsCalls = 0;
let deployCalls = 0;
let createdSubdomain = 'stub-project';
let lastProjectRequest;
let projectReply;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (status, payload) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'POST' && req.url === '/v1/auth/temp-create') {
      tempCreateCalls++;
      assert.deepEqual(JSON.parse(body), {});
      send(201, {
        ok: true,
        data: {
          access_token: 'smt_e2e_temp',
          key: 'smt_e2e_temp',
          key_prefix: 'smt_e2e',
          key_id: 'key_e2e',
          scopes: ['projects', 'deploy', 'promote', 'db', 'fs', 'logs', 'smoke', 'browser'],
          expires_at: new Date(Date.now() + 10_800_000).toISOString(),
          ttl_seconds: 10800,
          claim_token: 'swtc_e2e',
          claim_url: 'https://somewhere.cloud/claim?token=swtc_e2e',
        },
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/projects') {
      projectsCalls++;
      lastProjectRequest = JSON.parse(body);
      const project = projectReply?.(lastProjectRequest)
        ?? { id: 'proj_e2e_1', name: lastProjectRequest.name, subdomain: lastProjectRequest.subdomain };
      createdSubdomain = project.subdomain;
      send(201, {
        ok: true,
        data: project,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/deploy') {
      deployCalls++;
      send(200, {
        ok: true,
        data: { files: 1, url: `https://${createdSubdomain}.somewhere.cloud`, has_functions: false, ...SERVER_DEPLOY_FIELDS },
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/auth/temp-handoff/register') {
      send(201, { ok: true, data: { handoff_id: 'cch_e2e', expires_at: new Date(Date.now() + 10_800_000).toISOString() } });
      return;
    }

    send(404, { ok: false, error: 'NOT_FOUND', message: `no stub route for ${req.method} ${req.url}` });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const apiUrl = `http://127.0.0.1:${port}/v1`;

// The mock HTTP server above lives IN THIS PROCESS's event loop. spawnSync
// would block that event loop until the child exits — the child's requests
// would sit unserviced and the whole test would hang. Use async spawn and
// await completion instead, so the server keeps handling requests while the
// child runs.
// Fields only the server's deploy result carries. `--json` must pass them
// through on every path, temporary or signed in.
const SERVER_DEPLOY_FIELDS = {
  version: 7,
  release_id: 'rel_e2e_7',
  stage_timing_ms: { upload: 12, compile: 340, publish: 25 },
  warnings: ['e2e warning'],
  reference_check: { status: 'passed' },
};

function run(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd: env.cwd,
      env: { ...process.env, ...env.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

test('deploy while logged out — mint, auto-create project, claim relay, then silent reuse', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-fixture-'));
  writeFileSync(join(fixtureDir, 'index.html'), '<html><body>hi</body></html>\n');

  const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl };

  const first = await run(['deploy'], { cwd: fixtureDir, env });
  assert.equal(first.status, 0, `expected exit 0, got ${first.status}\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  assert.match(first.stdout, /Live URL:/);
  assert.match(first.stdout, /Open https:\/\/somewhere\.cloud\/claim/);
  assert.match(first.stdout, /Expires in about 3 hours/);
  assert.match(first.stdout, /"Save project and connect agent".*connect this terminal automatically/);
  assert.ok(first.stdout.includes('https://somewhere.cloud/claim?token=swtc_e2e'), 'claim URL present in stdout');

  const configPath = join(HOME, '.somewhere', 'config.json');
  assert.ok(existsSync(configPath), 'config.json written');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.temporary, true);
  assert.equal(config.token, 'smt_e2e_temp');
  assert.equal(config.claim_url, 'https://somewhere.cloud/claim?token=swtc_e2e');
  assert.equal(config.claim_handoff.handoff_id, 'cch_e2e');
  assert.equal(config.claim_handoff.project_id, 'proj_e2e_1');
  assert.notEqual(config.claim_handoff.verifier, config.claim_url, 'CLI proof is distinct from the browser claim URL');

  const projectFilePath = join(fixtureDir, '.somewhere.json');
  assert.ok(existsSync(projectFilePath), '.somewhere.json written in the fixture dir');
  const projectFile = JSON.parse(readFileSync(projectFilePath, 'utf8'));
  assert.equal(projectFile.project_id, 'proj_e2e_1');

  assert.equal(tempCreateCalls, 1, 'exactly one temp-create call after the first deploy');
  assert.equal(projectsCalls, 1, 'exactly one project auto-create call');
  assert.equal(deployCalls, 1);

  // Second run in the SAME window (same HOME, same fixture dir with
  // .somewhere.json already present) must reuse the cached credential AND
  // the linked project silently — no second temp-create, no second project.
  const second = await run(['deploy'], { cwd: fixtureDir, env });
  assert.equal(second.status, 0, `expected exit 0, got ${second.status}\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
  assert.match(second.stdout, /Live URL:/);
  assert.match(second.stdout, /Expires in about 3 hours\./);
  assert.match(second.stdout, /Open https:\/\/somewhere\.cloud\/claim/);
  assert.match(second.stdout, /"Save project and connect agent".*connect this terminal automatically/);

  assert.equal(tempCreateCalls, 1, 'still exactly ONE temp-create total — silent reuse');
  assert.equal(projectsCalls, 1, 'still exactly ONE project create total — .somewhere.json was reused');
  assert.equal(deployCalls, 2);
});

test('deploy --temporary reuses old temp configs without temp_expires_at and keeps fallback copy', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-home-oldconfig-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-fixture-oldconfig-'));
  writeFileSync(join(fixtureDir, 'index.html'), '<html><body>hi</body></html>\n');
  writeFileSync(join(fixtureDir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_e2e_old',
    name: 'old-temp',
    subdomain: 'old-temp',
  }) + '\n');

  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_old_temp',
    temporary: true,
    claim_url: 'https://somewhere.cloud/claim?token=swtc_old',
    user: { email: '', username: '' },
  }) + '\n');

  const beforeTempCreateCalls = tempCreateCalls;
  const result = await run(['deploy', '--temporary'], {
    cwd: fixtureDir,
    env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /Live URL:/);
  assert.match(result.stdout, /Temporary app\.\s+Open https:\/\/somewhere\.cloud\/claim/);
  assert.doesNotMatch(result.stdout, /Expires (?:about|in)/);
  assert.match(result.stdout, /https:\/\/somewhere\.cloud\/claim\?token=swtc_old/);
  assert.equal(tempCreateCalls, beforeTempCreateCalls, 'missing temp_expires_at falls back without minting a new temp session');
});

test('deploy --json with no stored credential deploys and emits the anonymous contract', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-home-nohint-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-fixture-nohint-'));
  writeFileSync(join(fixtureDir, 'index.html'), '<html></html>\n');

  const result = await run(['deploy', '--json'], {
    cwd: fixtureDir,
    env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const config = JSON.parse(readFileSync(join(HOME, '.somewhere', 'config.json'), 'utf8'));
  const project = JSON.parse(readFileSync(join(fixtureDir, '.somewhere.json'), 'utf8'));
  assert.deepEqual(JSON.parse(result.stdout), {
    files: 1,
    has_functions: false,
    ...SERVER_DEPLOY_FIELDS,
    uploaded: { static_files: ['index.html'], functions: [] },
    url: `https://${project.subdomain}.somewhere.cloud`,
    claim_url: 'https://somewhere.cloud/claim?token=swtc_e2e',
    expires_at: config.temp_expires_at,
    claim_connects_agent: true,
  }, 'the temporary contract adds claim fields to the server result; it does not replace it');
  assert.equal(result.stderr, '');
});

// --- `--temporary` means temporary, whatever the login state ---------------
//
// Being logged in used to override the flag ("Already logged in — deploying to
// your account."), which also dragged in account mode's linked-project
// requirement, so `--temporary` in an unlinked directory failed outright
// instead of doing the one thing it was asked to do.

function realLoginHome(prefix) {
  const HOME = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_real_account',
    user: { email: 'dev@example.com', username: 'dev' },
  }) + '\n');
  return HOME;
}

test('--temporary while logged in and unlinked takes the temporary path, no link required', async () => {
  const HOME = realLoginHome('sw-temp-e2e-home-loggedin-');
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-fixture-loggedin-'));
  writeFileSync(join(fixtureDir, 'index.html'), '<html><body>hi</body></html>\n');

  const beforeTempCreate = tempCreateCalls;
  const beforeProjects = projectsCalls;
  const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl };

  const first = await run(['deploy', '--temporary'], { cwd: fixtureDir, env });
  assert.equal(first.status, 0, `expected exit 0, got ${first.status}\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  assert.doesNotMatch(first.stdout, /Already logged in/);
  assert.doesNotMatch(first.stdout + first.stderr, /No project linked/);
  // Where it went and how long it lives.
  assert.match(first.stdout, /Live URL:/);
  assert.match(first.stdout, /Open https:\/\/somewhere\.cloud\/claim/);
  assert.match(first.stdout, /Expires in about 3 hours/);
  assert.match(first.stdout, /somewhere init --link --project proj_e2e_1/);
  assert.equal(tempCreateCalls, beforeTempCreate + 1, 'one temporary session minted');
  assert.equal(projectsCalls, beforeProjects + 1, 'the throwaway project was auto-created');

  // The account login survives it, and the directory keeps its own link state.
  const config = JSON.parse(readFileSync(join(HOME, '.somewhere', 'config.json'), 'utf8'));
  assert.equal(config.token, 'smt_real_account', 'real login untouched');
  assert.equal(config.temporary, undefined, 'real login was not downgraded to a temporary one');
  assert.equal(existsSync(join(fixtureDir, '.somewhere.json')), false,
    'a throwaway the account does not own is not written into the directory link');

  const sideCar = JSON.parse(readFileSync(join(HOME, '.somewhere', 'temp-session.json'), 'utf8'));
  assert.equal(sideCar.token, 'smt_e2e_temp');
  assert.equal(sideCar.projects[realpathSync(fixtureDir)].project_id, 'proj_e2e_1', 'recorded for this project root');
  assert.equal(sideCar.project, undefined);

  // A re-run in the same window redeploys the SAME throwaway.
  const second = await run(['deploy', '--temporary'], { cwd: fixtureDir, env });
  assert.equal(second.status, 0, `expected exit 0, got ${second.status}\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
  assert.equal(tempCreateCalls, beforeTempCreate + 1, 'no second temporary session');
  assert.equal(projectsCalls, beforeProjects + 1, 'no second throwaway project');
});

test('logged in and linked with NO flag still deploys to the account, unchanged', async () => {
  const HOME = realLoginHome('sw-temp-e2e-home-account-');
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-fixture-account-'));
  writeFileSync(join(fixtureDir, 'index.html'), '<html><body>hi</body></html>\n');
  writeFileSync(join(fixtureDir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_account_1',
    name: 'mine',
    subdomain: 'mine',
  }) + '\n');

  const beforeTempCreate = tempCreateCalls;
  const beforeProjects = projectsCalls;
  const result = await run(['deploy'], {
    cwd: fixtureDir,
    env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /Open https:\/\/somewhere\.cloud\/claim/, 'the account path relays no claim URL');
  assert.match(result.stdout, /Live at /);
  assert.equal(tempCreateCalls, beforeTempCreate, 'no temporary session minted for an account deploy');
  assert.equal(projectsCalls, beforeProjects, 'no project auto-created for an account deploy');
  assert.equal(existsSync(join(HOME, '.somewhere', 'temp-session.json')), false);
});

test('signed-in deploy --json prints the server result unchanged, with no claim fields', async () => {
  const HOME = realLoginHome('sw-temp-e2e-home-account-json-');
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sw-temp-e2e-fixture-account-json-'));
  writeFileSync(join(fixtureDir, 'index.html'), '<html><body>hi</body></html>\n');
  writeFileSync(join(fixtureDir, '.somewhere.json'), JSON.stringify({
    project_id: 'proj_account_json',
    name: 'mine-json',
    subdomain: 'mine-json',
  }) + '\n');

  const beforeTempCreate = tempCreateCalls;
  const result = await run(['deploy', '--json'], {
    cwd: fixtureDir,
    env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl },
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const out = JSON.parse(result.stdout);
  for (const [key, value] of Object.entries(SERVER_DEPLOY_FIELDS)) assert.deepEqual(out[key], value, `${key} passes through`);
  for (const key of ['claim_url', 'expires_at', 'claim_connects_agent']) assert.equal(key in out, false, `no ${key} on an account deploy`);
  assert.equal(tempCreateCalls, beforeTempCreate, 'no temporary session minted for an account deploy');
});

test('deploy rejects an empty directory locally while static-only and functions-only projects still deploy', async () => {
  const callsBeforeEmpty = { tempCreateCalls, projectsCalls, deployCalls };
  const emptyHome = mkdtempSync(join(tmpdir(), 'sw-empty-deploy-home-'));
  const emptyDir = mkdtempSync(join(tmpdir(), 'sw-empty-deploy-tree-'));
  const empty = await run(['deploy'], {
    cwd: emptyDir,
    env: { HOME: emptyHome, USERPROFILE: emptyHome, SOMEWHERE_API_URL: apiUrl },
  });

  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /No deployable source found/);
  assert.match(empty.stderr, /Create an index\.html or add raw app source files/);
  assert.match(empty.stderr, /serverless handlers under functions\//);
  assert.deepEqual(
    { tempCreateCalls, projectsCalls, deployCalls },
    callsBeforeEmpty,
    'empty deploy must not authenticate, provision, or upload',
  );
  assert.equal(existsSync(join(emptyHome, '.somewhere', 'config.json')), false);

  for (const fixture of [
    { name: 'static', path: 'index.html', content: '<html><body>ok</body></html>\n' },
    {
      name: 'functions',
      path: join('functions', 'api', 'ping.ts'),
      content: 'export default async function () { return Response.json({ ok: true }); }\n',
    },
  ]) {
    const home = mkdtempSync(join(tmpdir(), `sw-${fixture.name}-deploy-home-`));
    const dir = mkdtempSync(join(tmpdir(), `sw-${fixture.name}-deploy-tree-`));
    mkdirSync(dirname(join(dir, fixture.path)), { recursive: true });
    writeFileSync(join(dir, fixture.path), fixture.content);
    const beforeDeploys = deployCalls;
    const result = await run(['deploy'], {
      cwd: dir,
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
    });
    assert.equal(
      result.status,
      0,
      `${fixture.name}-only deploy failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(deployCalls, beforeDeploys + 1, `${fixture.name}-only source must reach deploy`);
  }
});

test('deploy help sends readers to the reported expiry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-temp-help-home-'));
  const result = await run(['deploy', '--help'], {
    cwd: home, env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
  });
  assert.equal(result.status, 0, result.stderr);
  const help = result.stdout.replace(/\s+/g, ' ');
  assert.match(help, /--temporary Deploy to a temporary workspace and show when it expires/);
  assert.doesNotMatch(help, /\b\d+-hour workspace\b/);
});

test('the first temporary deploy after signed-out init uses the chosen name on both hostname contracts', async () => {
  for (const serverAssignsHostname of [false, true]) {
    const base = mkdtempSync(join(tmpdir(), 'sw-temp-starter-'));
    const cwd = join(base, 'unrelated-folder');
    const home = join(base, 'home');
    const bin = join(base, 'bin');
    for (const dir of [cwd, home, bin]) mkdirSync(dir);
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const env = { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl, PATH: bin + ':' + process.env.PATH };
    if (serverAssignsHostname) {
      projectReply = request => ({ id: 'proj_e2e_1', name: request.name, subdomain: 'planner-notes-0123456789ab', status: 'draft' });
    }
    try {
      const init = await run(['init', '--name', 'Planner & Notes', '--template', 'minimal', '--json'], { cwd, env });
      assert.equal(init.status, 0, init.stdout + init.stderr);
      assert.equal(JSON.parse(init.stdout).name, 'Planner & Notes');
      const result = await run(['deploy', '--json'], { cwd, env });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(lastProjectRequest.name, 'Planner & Notes');
      assert.match(lastProjectRequest.subdomain, /^planner-notes-[a-z0-9]{4}$/);
      const expected = serverAssignsHostname ? 'planner-notes-0123456789ab' : lastProjectRequest.subdomain;
      const link = JSON.parse(readFileSync(join(cwd, '.somewhere.json'), 'utf8'));
      assert.equal(link.name, 'Planner & Notes');
      assert.equal(link.subdomain, expected);
      assert.equal(JSON.parse(result.stdout).url, `https://${expected}.somewhere.cloud`);
    } finally {
      projectReply = undefined;
    }
  }
});

test('an existing temporary project with the same name is never adopted or overwritten by an unlinked folder', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-temp-reused-name-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'sw-temp-reused-name-project-'));
  writeFileSync(join(cwd, 'index.html'), '<html><body>another project</body></html>');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ somewhere: { project_name: 'Planner & Notes' } }));
  projectReply = request => ({ id: 'already-live', name: request.name, subdomain: 'planner-notes-0123456789ab', status: 'active' });
  const before = deployCalls;
  try {
    const result = await run(['deploy', '--force'], { cwd, env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl } });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /A temporary project already uses this name/);
    assert.equal(deployCalls, before);
    assert.equal(existsSync(join(cwd, '.somewhere.json')), false);
  } finally {
    projectReply = undefined;
  }
});

test.after(() => server.close());
