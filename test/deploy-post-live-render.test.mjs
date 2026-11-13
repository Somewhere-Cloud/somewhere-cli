// A release whose blank-page check runs after the deploy answered (post_live_render: pending): the CLI reads the
// settled check from GET /deploy/log?release_id= for up to 5 s before its final line.
//   - blank → the same DEPLOY_BLANK_PAGE outcome a gated deploy prints, exit 1, no base recorded;
//   - still pending at 5 s → "live; blank-page check still running, see the deploy log", exit 0;
//   - passed → the result carries that blank_page_check, exit 0;
//   - no pending check → no log read at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const PROJECT = 'aaaaaaaa-1111-4222-8333-555555555555';
const BLANK = { outcome: 'BLANK', reason: 'blank', message: 'The page rendered blank.', policy: 'rejected', verification_mode: 'browser' };
const CLEAR = { outcome: 'CLEAR', message: 'rendered', policy: 'accepted', verification_mode: 'browser' };
const REJECTION = {
  ok: false, error: 'DEPLOY_BLANK_PAGE',
  message: 'The page rendered blank. The previous version is still live for visitors. A page renders when index.html loads the app with a module script and the browser entry mounts visible content.',
  data: { release_error_code: 'POSTVERIFY_BLANK', release_id: 'rel_new', active_release_id: 'rel_old', base_release_id: 'rel_old', blank_page_check: BLANK },
};

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, [distIndex, ...args], { cwd, env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr, ms: Date.now() - started }));
  });
}
function fixture(link) {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-postlive-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-postlive-fixture-'));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_post_live', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
  writeFileSync(join(dir, 'index.html'), '<html><body>post live</body></html>\n');
  if (link) writeFileSync(join(dir, '.somewhere.json'), JSON.stringify(link, null, 2) + '\n');
  return { HOME, dir };
}
const sendJson = (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };

/** logAnswers: what successive GET /deploy/log?release_id= reads return (the last one repeats). */
function server({ pending = true, logAnswers = [] } = {}) {
  const reads = [];
  const handler = (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.includes('/notices')) return sendJson(res, 200, { ok: true, data: { notices: [] } });
      if (req.method === 'GET' && req.url.startsWith('/v1/deploy/status')) {
        return sendJson(res, 200, { ok: true, data: { published: true, active_release_id: 'rel_old', prod_version: 7 } });
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/projects/')) {
        return sendJson(res, 200, { ok: true, data: { id: PROJECT, name: 'p', subdomain: 'post-live', status: 'deployed' } });
      }
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        return sendJson(res, 200, { ok: true, data: {
          project_id: PROJECT, version: 8, url: 'https://post-live.somewhere.site', has_functions: false,
          release_id: 'rel_new', active_release_id: 'rel_new', base_release_id: 'rel_old', status: 'success',
          ...(pending ? { post_live_render: { status: 'pending' } } : { blank_page_check: CLEAR }),
        } });
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/deploy/log')) {
        const q = new URL(req.url, 'http://x').searchParams;
        reads.push({ project_id: q.get('project_id'), release_id: q.get('release_id') });
        const answer = logAnswers[Math.min(reads.length - 1, logAnswers.length - 1)];
        return answer.status ? sendJson(res, answer.status, answer.body) : sendJson(res, 200, { ok: true, data: answer });
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  };
  return { handler, reads };
}
async function withServer(handler, fn) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${s.address().port}/v1`); } finally { await new Promise((r) => s.close(r)); }
}
const deploy = (f, apiUrl, extra = []) => run(['deploy', '--project', PROJECT, ...extra], { cwd: f.dir, env: { HOME: f.HOME, USERPROFILE: f.HOME, SOMEWHERE_API_URL: apiUrl } });
const pendingRead = { release_id: 'rel_new', post_live_render: { status: 'pending' }, blank_page_check: null };

test('pending, then blank: the deploy fails with the same DEPLOY_BLANK_PAGE a gated deploy prints (exit 1)', async () => {
  const f = fixture(); const srv = server({ logAnswers: [pendingRead, { release_id: 'rel_new', post_live_render: { status: 'rolled_back', blank_page_check: BLANK }, blank_page_check: BLANK, rejection: REJECTION }] });
  await withServer(srv.handler, async (apiUrl) => {
    const human = await deploy(f, apiUrl);
    assert.equal(human.status, 1, human.stdout + human.stderr);
    assert.match(human.stderr, /The page rendered blank\. The previous version is still live/);
    assert.match(human.stderr, /DEPLOY_BLANK_PAGE, HTTP 400/);
    assert.doesNotMatch(human.stdout, /Live at/, 'never claims the blank release is live');
    assert.deepEqual(srv.reads[0], { project_id: PROJECT, release_id: 'rel_new' }, 'reads the exact release it deployed');
    const json = await deploy(f, apiUrl, ['--json']);
    assert.equal(json.status, 1);
    const out = JSON.parse(json.stdout);
    assert.equal(out.error, 'DEPLOY_BLANK_PAGE');
    assert.equal(out.data.release_error_code, 'POSTVERIFY_BLANK');
    assert.equal(out.data.active_release_id, 'rel_old');
  });
});

test('a linked folder keeps its old base after a blank rollback, so the next deploy is not refused as stale', async () => {
  const f = fixture({ project_id: PROJECT, source_base: { project_id: PROJECT, release_id: 'rel_old' } });
  const before = readFileSync(join(f.dir, '.somewhere.json'), 'utf8');
  const srv = server({ logAnswers: [{ ...pendingRead, post_live_render: { status: 'rolled_back' }, rejection: REJECTION }] });
  await withServer(srv.handler, async (apiUrl) => {
    const r = await run(['deploy'], { cwd: f.dir, env: { HOME: f.HOME, USERPROFILE: f.HOME, SOMEWHERE_API_URL: apiUrl } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /DEPLOY_BLANK_PAGE/, 'failed on the blank page, not on the link');
    assert.equal(srv.reads.length, 1, 'the linked deploy reached the post-live read');
    assert.equal(readFileSync(join(f.dir, '.somewhere.json'), 'utf8'), before, 'the rejected release is not recorded as this folder\'s base');
  });
});

test('still pending after 5 s: live, with the still-running line, exit 0', async () => {
  const f = fixture(); const srv = server({ logAnswers: [pendingRead] });
  await withServer(srv.handler, async (apiUrl) => {
    const human = await deploy(f, apiUrl);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout + human.stderr, /Render check still running; see its result with: somewhere call project_deploy_log/);
    assert.ok(human.ms >= 4500 && human.ms < 12000, `waited about 5 s (${human.ms} ms)`);
    assert.ok(srv.reads.length >= 3, `polled the log (${srv.reads.length} reads)`);
    const json = await deploy(f, apiUrl, ['--json']);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout).post_live_render, { status: 'pending', note: "Render check still running; see its result with: somewhere call project_deploy_log '{}'" });
  });
});

test('a log read that fails is retried, never taken as a pass', async () => {
  const f = fixture(); const srv = server({ logAnswers: [{ status: 503, body: { ok: false, error: 'AUTHORITY_UNAVAILABLE', message: 'busy' } }, { ...pendingRead, post_live_render: { status: 'rolled_back' }, rejection: REJECTION }] });
  await withServer(srv.handler, async (apiUrl) => {
    const r = await deploy(f, apiUrl);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /DEPLOY_BLANK_PAGE/);
  });
});

test('passed: the result carries the settled blank_page_check, exit 0, no extra line', async () => {
  const f = fixture(); const srv = server({ logAnswers: [{ release_id: 'rel_new', post_live_render: { status: 'clear', blank_page_check: CLEAR }, blank_page_check: CLEAR }] });
  await withServer(srv.handler, async (apiUrl) => {
    const json = await deploy(f, apiUrl, ['--json']);
    assert.equal(json.status, 0, json.stderr);
    const out = JSON.parse(json.stdout);
    assert.deepEqual(out.blank_page_check, CLEAR);
    assert.equal(out.post_live_render.status, 'clear');
    const human = await deploy(f, apiUrl);
    assert.equal(human.status, 0);
    assert.doesNotMatch(human.stdout + human.stderr, /still running/);
  });
});

test('no pending check (a gated release): the deploy log is not read', async () => {
  const f = fixture(); const srv = server({ pending: false, logAnswers: [pendingRead] });
  await withServer(srv.handler, async (apiUrl) => {
    const r = await deploy(f, apiUrl, ['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(srv.reads.length, 0);
    assert.equal(existsSync(distIndex), true);
  });
});
