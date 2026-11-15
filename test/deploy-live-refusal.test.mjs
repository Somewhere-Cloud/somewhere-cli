// A refusal that left the new version live (tsk_bfd50899): the platform switched production to it and could
// not switch back (409 AUTO_ROLLBACK_BLOCKED with data.live, or the post-live blank check's
// POSTVERIFY_ROLLBACK_BLOCKED). The CLI says plainly that it is live, records it as the folder's base so the
// corrected deploy is admitted without --force, exits non-zero, and --json carries live: true. A refusal that
// left production as it was keeps the old base and the old wording.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(root, 'dist', 'index.js');
const { liveRefusal, formatLiveRefusalMessage } = await import(join(root, 'dist', 'lib', 'live-refusal.js'));
const { CliApiError } = await import(join(root, 'dist', 'lib', 'client.js'));
const PROJECT = 'bbbbbbbb-1111-4222-8333-555555555555';
const LIVE_MESSAGE = 'This version is live, but its page rendered blank (the page has no visible content), and the automatic switch back to the previous version was not allowed: The access rules of "tickets" in that version differ from the live version\'s. Deploy a corrected version, or the previous version\'s source again, to replace it.';
const BLOCKED_409 = {
  ok: false, error: 'AUTO_ROLLBACK_BLOCKED', message: LIVE_MESSAGE, retry: false,
  data: { release_error_code: 'AUTO_ROLLBACK_BLOCKED', live: true, release_id: 'rel_new', active_release_id: 'rel_new', version: 8, base_release_id: 'rel_old' },
};
const BLANK = { outcome: 'BLANK', reason: 'blank', message: 'The page rendered blank.', policy: 'rejected', verification_mode: 'browser' };
const ASYNC_BLOCKED = {
  ok: false, error: 'DEPLOY_BLANK_PAGE',
  message: 'The page rendered blank. The automatic rollback did not complete, so this blank release is still live. A deploy of a working version, or project_rollback, replaces it.',
  data: { release_error_code: 'POSTVERIFY_ROLLBACK_BLOCKED', release_id: 'rel_new', active_release_id: 'rel_new', base_release_id: 'rel_old', blank_page_check: BLANK },
};
const SCHEMA_REFUSED = {
  ok: false, error: 'SCHEMA_DEPLOY_REFUSED', retry: false,
  message: 'This deploy was refused by its db/schema.ts — nothing was applied. The previous version is still live.',
  data: { release_error_code: 'SCHEMA_DEPLOY_REFUSED', release_id: 'rel_new', active_release_id: 'rel_old', base_release_id: 'rel_old' },
};

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], { cwd, env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => { stderr += '\n[test: killed after 30 s]'; child.kill('SIGKILL'); }, 30000);
    child.on('close', (status) => { clearTimeout(timer); resolvePromise({ status, stdout, stderr }); });
  });
}
function fixture() {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-live409-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-live409-fixture-'));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_live_409', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
  writeFileSync(join(dir, 'index.html'), '<html><body>live refusal</body></html>\n');
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({
    project_id: PROJECT,
    source_base: { project_id: PROJECT, release_id: 'rel_old', at: '2026-11-15T00:00:00.000Z' },
    last_deploy: { project_id: PROJECT, last_deployed_version: 7, at: '2026-11-15T00:00:00.000Z', release_id: 'rel_old' },
  }, null, 2) + '\n');
  return { HOME, dir };
}
const link = (f) => JSON.parse(readFileSync(join(f.dir, '.somewhere.json'), 'utf8'));
const sendJson = (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };

/** answers: what successive POST /v1/deploy calls return ({ status, body } or a success data object). */
function server({ answers, logAnswer = null }) {
  const uploads = [];
  const handler = (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.includes('/notices')) return sendJson(res, 200, { ok: true, data: { notices: [] } });
      if (req.method === 'GET' && req.url.startsWith('/v1/deploy/status')) return sendJson(res, 200, { ok: true, data: { published: true, active_release_id: 'rel_old', prod_version: 7 } });
      if (req.method === 'GET' && req.url.startsWith('/v1/projects/')) return sendJson(res, 200, { ok: true, data: { id: PROJECT, name: 'p', subdomain: 'live-409', status: 'deployed' } });
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        uploads.push(JSON.parse(body));
        const answer = answers[Math.min(uploads.length - 1, answers.length - 1)];
        return answer.http ? sendJson(res, answer.http, answer.body) : sendJson(res, 200, { ok: true, data: answer });
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/deploy/log') && logAnswer) return sendJson(res, 200, { ok: true, data: logAnswer });
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  };
  return { handler, uploads };
}
async function withServer(handler, fn) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${s.address().port}/v1`); } finally { await new Promise((r) => s.close(r)); }
}
const deploy = (f, apiUrl, extra = []) => run(['deploy', '--yes', ...extra], { cwd: f.dir, env: { HOME: f.HOME, USERPROFILE: f.HOME, SOMEWHERE_API_URL: apiUrl } });
const corrected = { project_id: PROJECT, version: 9, url: 'https://live-409.somewhere.site', has_functions: false, release_id: 'rel_fix', active_release_id: 'rel_fix', base_release_id: 'rel_new', status: 'success' };

test('live refusals are recognised only when production serves the refused release', () => {
  const err = (data) => new CliApiError('X', 'm', 409, data);
  assert.deepEqual(liveRefusal(err(BLOCKED_409.data)), { code: 'X', releaseId: 'rel_new', version: 8 });
  assert.deepEqual(liveRefusal(err(ASYNC_BLOCKED.data)), { code: 'X', releaseId: 'rel_new', version: null });
  assert.equal(liveRefusal(err(SCHEMA_REFUSED.data)), null, 'production still serves the old release');
  assert.equal(liveRefusal(err({ ...BLOCKED_409.data, active_release_id: 'rel_other' })), null, 'live:true never outranks the pointer');
  assert.equal(liveRefusal(err({ live: true })), null, 'no release named: nothing to record');
  assert.equal(liveRefusal(new Error('plain')), null);
  assert.equal(formatLiveRefusalMessage(LIVE_MESSAGE), LIVE_MESSAGE, 'the platform\'s own live statement is printed as written');
  assert.equal(formatLiveRefusalMessage(ASYNC_BLOCKED.message),
    `This version is live, but it failed its check and could not be switched back automatically: ${ASYNC_BLOCKED.message}`,
    'framed as live; its own next step is kept, not repeated');
  assert.match(formatLiveRefusalMessage('The role check refused.'), /^This version is live, but .*: The role check refused\. Deploy a corrected version to replace it\.$/);
});

test('409 AUTO_ROLLBACK_BLOCKED, live: says it is live, records the new release as the base, exits 1; the corrected deploy is admitted without --force', async () => {
  const f = fixture(); const srv = server({ answers: [{ http: 409, body: BLOCKED_409 }, corrected] });
  await withServer(srv.handler, async (apiUrl) => {
    const r = await deploy(f, apiUrl);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const out = r.stdout + r.stderr;
    assert.match(out, /This version is live, but its page rendered blank/);
    assert.match(out, /AUTO_ROLLBACK_BLOCKED, HTTP 409/);
    assert.doesNotMatch(out, /Deploy failed/, 'never headed as a failed deploy');
    assert.match(out, /next `somewhere deploy` here replaces it without --force/);
    assert.equal(srv.uploads[0].base_release_id, 'rel_old');
    const after = link(f);
    assert.equal(after.source_base.release_id, 'rel_new', 'the live release is the folder\'s base');
    assert.equal(after.last_deploy.last_deployed_version, 8);
    assert.equal(after.last_deploy.release_id, 'rel_new');
    const again = await deploy(f, apiUrl);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(srv.uploads[1].base_release_id, 'rel_new', 'the corrected deploy declares the live release as its base');
    assert.equal(srv.uploads[1].force, undefined, 'no --force');
    assert.equal(link(f).source_base.release_id, 'rel_fix');
  });
});

test('--json carries live: true, the live release and version, and exits 1', async () => {
  const f = fixture(); const srv = server({ answers: [{ http: 409, body: BLOCKED_409 }] });
  await withServer(srv.handler, async (apiUrl) => {
    const r = await deploy(f, apiUrl, ['--json']);
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.error, 'AUTO_ROLLBACK_BLOCKED');
    assert.equal(out.live, true);
    assert.equal(out.deployment_outcome, 'live');
    assert.equal(out.release_id, 'rel_new');
    assert.equal(out.version, 8);
    assert.equal(out.base_recorded, true);
    assert.equal(out.data.live, true, 'the platform\'s data is kept');
    assert.equal(out.message, LIVE_MESSAGE);
    assert.equal(link(f).source_base.release_id, 'rel_new');
  });
});

test('the post-live blank check that could not roll back: live, base recorded at the version the deploy answered', async () => {
  const f = fixture();
  const srv = server({
    answers: [{ ...corrected, version: 8, release_id: 'rel_new', active_release_id: 'rel_new', base_release_id: 'rel_old', post_live_render: { status: 'pending' } }],
    logAnswer: { release_id: 'rel_new', post_live_render: { status: 'rollback_blocked', blank_page_check: BLANK }, blank_page_check: BLANK, rejection: ASYNC_BLOCKED },
  });
  await withServer(srv.handler, async (apiUrl) => {
    const r = await deploy(f, apiUrl);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const out = r.stdout + r.stderr;
    assert.match(out, /This version is live, but it failed its check and could not be switched back automatically: The page rendered blank\./);
    assert.match(out, /Live at https:\/\/live-409\.somewhere\.site/);
    assert.doesNotMatch(out, /Deploy failed/);
    const after = link(f);
    assert.equal(after.source_base.release_id, 'rel_new');
    assert.equal(after.last_deploy.last_deployed_version, 8);
  });
});

test('a refusal that left production as it was keeps the old base and the failed wording', async () => {
  const f = fixture(); const before = readFileSync(join(f.dir, '.somewhere.json'), 'utf8');
  const srv = server({ answers: [{ http: 409, body: SCHEMA_REFUSED }] });
  await withServer(srv.handler, async (apiUrl) => {
    const r = await deploy(f, apiUrl);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /Deploy failed/);
    assert.match(r.stdout + r.stderr, /SCHEMA_DEPLOY_REFUSED, HTTP 409/);
    assert.doesNotMatch(r.stdout + r.stderr, /This version is live/);
    assert.equal(readFileSync(join(f.dir, '.somewhere.json'), 'utf8'), before);
    const json = await deploy(f, apiUrl, ['--json']);
    assert.equal(JSON.parse(json.stdout).live, undefined);
  });
});
