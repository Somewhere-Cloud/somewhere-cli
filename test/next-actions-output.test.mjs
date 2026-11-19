/**
 * What a real `somewhere deploy` actually PRINTS.
 *
 * test/next-actions.test.mjs checks the decision; this runs the binary end to
 * end against a stub platform and checks the transcript an agent would read —
 * the acceptance line for : the deploy output itself has to say
 * how to look at the app in a browser.
 *
 * The negative half matters just as much: `--json` stdout stays the raw
 * platform response, byte for byte, with none of this in it.
 *
 * A first anonymous deploy has its own three-line handoff. Its stub includes
 * routine starter schema output and the privacy advisory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function withStubPlatform(deployData, fn) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        sendJson(res, 200, { ok: true, data: deployData });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/auth/temp-handoff/register') {
        sendJson(res, 201, { ok: true, data: {
          handoff_id: 'cch_temp_out', expires_at: new Date(Date.now() + 10_800_000).toISOString(),
        } });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function linkedFixture() {
  const home = mkdtempSync(join(tmpdir(), 'sw-next-out-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-next-out-fixture-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(
    join(home, '.somewhere', 'config.json'),
    JSON.stringify({ token: 'smt_deploy_out', user: { email: 'next@example.com' } }) + '\n',
  );
  writeFileSync(
    join(dir, '.somewhere.json'),
    JSON.stringify({
      project_id: 'proj_deploy_out',
      name: 'deploy-out',
      subdomain: 'deploy-out',
    }) + '\n',
  );
  writeFileSync(join(dir, 'index.html'), '<html><body>hi</body></html>\n');
  return { home, dir };
}

const DEPLOY_DATA = {
  project_id: 'proj_deploy_out',
  version: 3,
  release_id: 'rel_deploy_out',
  active_release_id: 'rel_deploy_out',
  files_deployed: 1,
  has_functions: false,
  warnings: [],
  status: 'success',
};

test('a successful deploy tells you how to look at the app in a browser', async () => {
  const { home, dir } = linkedFixture();
  await withStubPlatform(DEPLOY_DATA, async (apiUrl) => {
    const result = await run(['deploy'], {
      cwd: dir,
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Live at https:\/\/deploy-out\.somewhere\.site/);
    // The whole point: the screenshot/health check is named where it is needed.
    assert.match(result.stdout, /somewhere browser --screenshot/);
    assert.match(result.stdout, /somewhere verify/);
    // Offer the normal test workflow before the read-only visual checks.
    const suggestionLines = result.stdout
      .split('\n')
      .filter((line) => /^ {2}somewhere \S/.test(line));
    assert.deepEqual(suggestionLines.map((line) => line.trim().split(/ {2,}/)[0]), [
      'somewhere test', 'somewhere verify', 'somewhere browser --screenshot',
    ]);
    // And the existing preview guidance survived.
    assert.match(result.stdout, /use `somewhere preview` before changing what they see/);
  });
});

test('deploy --json emits the result and uploaded paths without human next steps', async () => {
  const { home, dir } = linkedFixture();
  await withStubPlatform(DEPLOY_DATA, async (apiUrl) => {
    const result = await run(['deploy', '--json'], {
      cwd: dir,
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { ...DEPLOY_DATA, uploaded: { static_files: ['index.html'], functions: [] } });
    assert.doesNotMatch(result.stdout, /somewhere browser/);
    assert.doesNotMatch(result.stdout, /somewhere verify/);
    assert.doesNotMatch(result.stdout, /next_actions/);
  });
});


/** Stub of the logged-out deploy contract: temp-create, project auto-create, deploy. */
async function withStubTempPlatform(fn) {
  let subdomain = 'temp-fresh';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/auth/temp-create') {
        assert.deepEqual(JSON.parse(body), {});
        sendJson(res, 201, {
          ok: true,
          data: {
            key: 'smt_temp_out',
            access_token: 'smt_temp_out',
            // The real scope set. `browser` is in it, which is why suggesting
            // `somewhere browser` on this path is legitimate and not a guess.
            scopes: ['projects', 'deploy', 'promote', 'db', 'fs', 'logs', 'smoke', 'browser'],
            expires_at: new Date(Date.now() + 10_800_000).toISOString(),
            ttl_seconds: 10800,
            claim_token: 'swtc_temp_out',
            claim_url: 'https://somewhere.cloud/claim?token=swtc_temp_out',
          },
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/projects') {
        const parsed = JSON.parse(body);
        subdomain = parsed.subdomain;
        sendJson(res, 201, {
          ok: true,
          data: { id: 'proj_temp_out', name: parsed.name, subdomain },
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        sendJson(res, 200, {
          ok: true,
          data: {
            project_id: 'proj_temp_out',
            version: 1,
            release_id: 'rel_temp_out',
            active_release_id: 'rel_temp_out',
            files_deployed: 1,
            has_functions: false,
            warnings: ['Database schema: table "notes" is created (4 columns).', 'A real warning.'],
            privacy_lines: ['Privacy facts', 'Warning: no privacy page found.'],
            status: 'success',
          },
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/auth/temp-handoff/register') {
        sendJson(res, 201, { ok: true, data: {
          handoff_id: 'cch_temp_out', expires_at: new Date(Date.now() + 10_800_000).toISOString(),
        } });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: `${req.method} ${req.url}` });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('first anonymous deploy ends with live URL, expiry and one claim instruction', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-temp-out-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-temp-out-fixture-'));
  writeFileSync(join(dir, 'index.html'), '<html><body>hi</body></html>\n');

  await withStubTempPlatform(async (apiUrl) => {
    const result = await run(['deploy'], {
      cwd: dir,
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const last = result.stdout.trimEnd().split('\n').slice(-3);
    assert.match(last[0], /^✓ Live URL: https:\/\//);
    assert.match(last[1], /^  Temporary app\. Expires in about 3 hours\./);
    assert.equal(last[2], '  Open https://somewhere.cloud/claim?token=swtc_temp_out and select "Save and connect agent" to work on the saved apps and create new ones. You can choose to include your other apps.');
    assert.doesNotMatch(result.stdout + result.stderr, /no privacy page|table "notes" is created|somewhere (claim|browser|preview)/);
    assert.match(result.stderr, /A real warning/);

    const detail = await run(['deploy', '--timing'], {
      cwd: dir,
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: apiUrl },
    });
    assert.equal(detail.status, 0, detail.stderr);
    assert.match(detail.stdout, /Warning: no privacy page found/);
    assert.match(detail.stderr, /table "notes" is created/);
  });
});
