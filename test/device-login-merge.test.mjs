import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLI_PACKAGE_VERSION } from './local-cli-pack.mjs';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const temporaryKey = 'smt_temporary_fixture_only';
const memberKey = 'smt_new_member_fixture_only';
const claimLink = 'https://somewhere.cloud/claim/swtc_fixture_only';
const email = 'member@example.invalid';

async function withFixture(t, { temporary = true, count = 2 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sw-device-merge-'));
  const configDir = join(root, '.somewhere');
  const configPath = join(configDir, 'config.json');
  mkdirSync(configDir);
  const original = JSON.stringify(temporary ? {
    token: temporaryKey, temporary: true, claim_url: claimLink,
    temp_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    user: { email: '', username: '' },
  } : { token: 'smt_previous_member_fixture_only', user: { email, username: '' } });
  writeFileSync(configPath, original, { mode: 0o600 });
  const folders = Array.from({ length: count }, (_, index) => {
    const projectId = `proj_merge_${index}`;
    const cwd = join(root, `folder-${index}`);
    mkdirSync(cwd);
    const link = join(cwd, '.somewhere.json');
    const linked = JSON.stringify({ project_id: projectId, name: projectId, subdomain: projectId, cli_version: CLI_PACKAGE_VERSION });
    writeFileSync(link, linked);
    writeFileSync(join(cwd, 'index.html'), `<html><body>${projectId}</body></html>`);
    return { cwd, link, linked, projectId };
  });
  const state = { mode: 'approved', expiresIn: 600, registered: [], polls: [], writes: [] };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.url === '/v1/auth/device-code') {
      state.registered.push({ merge: body.merge_temporary, temporaryBearer: req.headers.authorization === `Bearer ${temporaryKey}`,
        noBearer: req.headers.authorization === undefined, body });
      if (state.mode === 'refused') {
        send(401, { ok: false, error: 'AUTH_INVALID_CREDS', message: temporaryKey + ' ' + claimLink });
        return;
      }
      send(200, { ok: true, data: { verifier_bound: true, expires_in: state.expiresIn, approval_url: 'https://example.invalid/auth/device' } });
      return;
    }
    if (req.url === '/v1/auth/device-code/status') {
      state.polls.push({ body, noBearer: req.headers.authorization === undefined });
      if (state.mode === 'delivery-error') {
        send(503, { ok: false, error: 'DEVICE_CODE_REDEMPTION_UNAVAILABLE', message: temporaryKey + ' ' + claimLink });
        return;
      }
      send(200, { ok: true, data: state.mode === 'approved' ? {
        status: 'approved', token: memberKey, email, ...(temporary ? { merged_project_count: count } : {}),
      } : { status: state.mode } });
      return;
    }
    if (req.url === '/v1/deploy') {
      state.writes.push({ projectId: body.project_id, member: req.headers.authorization === `Bearer ${memberKey}`,
        temporary: req.headers.authorization === `Bearer ${temporaryKey}` });
      send(200, { ok: true, data: { project_id: body.project_id, files: 1, version: 1, url: 'https://example.invalid' } });
      return;
    }
    send(404, { ok: false, error: 'NOT_FOUND', message: 'Fixture route unavailable.' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const env = {
    ...process.env, HOME: root, USERPROFILE: root, SOMEWHERE_CONFIG_DIR: configDir,
    SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`, SOMEWHERE_NO_BROWSER: '1',
    SOMEWHERE_NO_NOTIFICATIONS: '1', SOMEWHERE_NO_UPDATE_CHECK: '1', CI: '1', NO_COLOR: '1',
  };
  function run(cwd, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd, env });
      const watchdog = setTimeout(() => child.kill(), 12_000);
      let output = '';
      child.stdout.on('data', chunk => output += chunk);
      child.stderr.on('data', chunk => output += chunk);
      child.once('error', reject);
      child.once('close', code => {
        clearTimeout(watchdog);
        resolve({ code, output });
      });
    });
  }
  return { folders, run, state, configPath };
}

test('device login saves two temporary projects and both folders deploy with their original links', async t => {
  const { folders, run, state, configPath } = await withFixture(t);
  const result = await run(folders[0].cwd, ['login']);
  assert.equal(result.code, 0);
  assert.match(result.output, /Code expires in 10 minutes\./);
  assert.match(result.output, /Added 2 temporary projects to member@example\.invalid\./);
  assert.equal(state.registered.length, 1);
  const [registered] = state.registered;
  assert.equal(registered.merge, true);
  assert.equal(registered.temporaryBearer, true);
  assert.equal(registered.body.expected_user_id, undefined);
  assert.equal(registered.body.projects, undefined);
  const [poll] = state.polls;
  assert.equal(poll.noBearer, true);
  assert.equal(poll.body.code, registered.body.code);
  assert.equal(createHash('sha256').update(poll.body.verifier).digest('hex'), registered.body.code_challenge);
  assert.ok(!result.output.includes(poll.body.verifier));
  assert.ok(![temporaryKey, memberKey, claimLink].some(secret => result.output.includes(secret)));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.ok(config.token === memberKey && !config.temporary && !config.claim_url);
  for (const folder of folders) {
    assert.ok(readFileSync(folder.link, 'utf8') === folder.linked);
    assert.equal((await run(folder.cwd, ['deploy', '--json'])).code, 0);
  }
  assert.deepEqual(state.writes, folders.map(({ projectId }) => ({ projectId, member: true, temporary: false })));
});

test('temporary login from an older pinned project transfers it with the running CLI', async t => {
  const { folders, run, state } = await withFixture(t, { count: 1 });
  writeFileSync(join(folders[0].cwd, 'package.json'), JSON.stringify({ somewhere: { cli_version: '0.38.123' } }));
  const result = await run(folders[0].cwd, ['login']);
  assert.equal(result.code, 0);
  assert.match(result.output, /Added 1 temporary project to member@example\.invalid\./);
  assert.equal(state.registered[0].merge, true);
});

test('a refused, denied, abandoned or failed redemption leaves the temporary project usable', async t => {
  const { folders, run, state, configPath } = await withFixture(t, { count: 1 });
  const [folder] = folders;
  for (const [mode, message] of [
    ['refused', /temporary session is invalid or expired/],
    ['denied', /denied in the browser/],
    ['pending', /Login timed out/],
    ['delivery-error', /delivery could not be confirmed/],
  ]) {
    state.mode = mode;
    state.expiresIn = mode === 'pending' ? 2 : 600;
    state.polls.length = 0;
    const before = readFileSync(configPath, 'utf8');
    const result = await run(folder.cwd, ['login']);
    assert.equal(result.code, 1, mode);
    assert.match(result.output, message);
    if (mode === 'pending') {
      assert.match(result.output, /Code expires in 2 seconds\./);
      assert.equal(state.polls.length, 1);
    }
    if (mode === 'delivery-error') assert.equal(state.polls.length, 1);
    assert.ok(![temporaryKey, claimLink].some(secret => result.output.includes(secret)));
    assert.ok(readFileSync(configPath, 'utf8') === before);
    assert.ok(JSON.parse(before).token === temporaryKey);
    assert.ok(readFileSync(folder.link, 'utf8') === folder.linked);
    assert.equal((await run(folder.cwd, ['deploy', '--json'])).code, 0);
    assert.deepEqual(state.writes.at(-1), { projectId: folder.projectId, member: false, temporary: true });
  }
});

test('an ordinary login retains its normal registration and prints the issued lifetime', async t => {
  const { folders, run, state, configPath } = await withFixture(t, { temporary: false, count: 1 });
  state.expiresIn = 75;
  const settings = join(folders[0].cwd, '..', '.claude.json');
  const existing = '{"mcpServers":{"custom":{"command":"fixture"}}}\n';
  writeFileSync(settings, existing);
  const result = await run(folders[0].cwd, ['login']);
  assert.equal(result.code, 0);
  assert.match(result.output, /Logged in as member@example\.invalid/);
  assert.equal(result.output.match(/^To connect Somewhere to Claude Code, run somewhere mcp install claude-code$/gm)?.length, 1);
  assert.equal(readFileSync(settings, 'utf8'), existing);
  assert.match(result.output, /Code expires in 75 seconds\./);
  assert.doesNotMatch(result.output, /Create an account: https:\/\/somewhere\.cloud/);
  assert.doesNotMatch(result.output, /Added .*temporary project/);
  assert.equal(state.registered[0].merge, undefined);
  assert.equal(state.registered[0].noBearer, true);
  assert.ok(JSON.parse(readFileSync(configPath, 'utf8')).token === memberKey);
});

test('login skips the Claude Code setup hint when Somewhere is configured', async t => {
  const { folders, run } = await withFixture(t, { temporary: false, count: 1 });
  const cwd = folders[0].cwd;
  const projectPath = join(cwd, '.mcp.json');
  const userPath = join(cwd, '..', '.claude.json');
  const config = '{"mcpServers":{"somewhere":{"command":"fixture"}}}\n';
  for (const path of [projectPath, userPath]) {
    writeFileSync(path, config);
    const result = await run(cwd, ['login']);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.output, /somewhere mcp install claude-code/);
    assert.equal(readFileSync(path, 'utf8'), config);
    rmSync(path);
  }
});
