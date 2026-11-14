import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// The edit loop: preview continues the folder's open preview (--new opens a
// fresh one), list and close, link --json, a stale folder base refused before
// any upload, and promote moving the folder's base so the next preview works.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const PROJECT = 'loop-project';

function run(args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', SOMEWHERE_NO_UPDATE_CHECK: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr, all: stdout + stderr }));
  });
}

const sha = (text) => createHash('sha256').update(text).digest('hex');

/** A fake platform holding one live release and its open previews. */
async function fakePlatform() {
  const state = {
    active: 'rel_live_1',
    seq: 1,
    previews: new Map(), // session -> { previewId, base, created }
    requests: [],
    preserveOnPromote: [],
  };
  const statusData = () => ({
    published: true,
    active_release_id: state.active,
    prod_version: state.seq,
    previews: [...state.previews].map(([session, p]) => ({
      preview_session_id: session,
      preview_id: p.previewId,
      base_release_id: p.base,
      created_at: new Date(p.created).toISOString(),
      last_updated_at: new Date(p.created).toISOString(),
      expires_at: new Date(p.created + 24 * 3600_000).toISOString(),
    })),
  });
  const json = (res, payload, status = 200) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  };
  let n = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://local');
      const body = raw ? JSON.parse(raw) : null;
      state.requests.push({ method: req.method, path: url.pathname, body });
      if (url.pathname.endsWith('/notices')) return json(res, { ok: true, data: { notices: [] } });
      if (url.pathname === '/mcp') {
        if (body.method === 'initialize') {
          return json(res, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'loop', version: '1' } } });
        }
        if (body.method === 'tools/call') {
          const data = body.params.name === 'project_get' ? { cloud_dev_allowed: true } : statusData();
          return json(res, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] } });
        }
        return json(res, { jsonrpc: '2.0', id: body.id, result: {} });
      }
      if (req.method === 'POST' && url.pathname === '/v1/deploy' && body.preview) {
        const session = body.preview_session_id;
        const existing = state.previews.get(session);
        if (body.expected_preview_id === null) {
          if (body.base_release_id !== state.active) {
            return json(res, { ok: false, error: { code: 'STALE_RELEASE_BASE', message: 'stale' } }, 409);
          }
          state.previews.set(session, { previewId: `rel_prev_${++n}`, base: state.active, created: Date.now() - 5 * 60_000 });
        } else {
          if (!existing || existing.previewId !== body.expected_preview_id) {
            return json(res, { ok: false, error: { code: 'DRAFT_CANDIDATE_CONFLICT', message: 'conflict' } }, 409);
          }
          existing.previewId = `rel_prev_${++n}`;
        }
        const p = state.previews.get(session);
        return json(res, { ok: true, data: { preview_session_id: session, preview_id: p.previewId, preview_url: 'https://loop-dev.example.test/' } });
      }
      if (req.method === 'POST' && url.pathname === `/v1/projects/${PROJECT}/preview/mint`) {
        return json(res, { ok: true, data: { preview_url: `https://loop-dev.example.test/__sw_cap?t=tok${++n}` } });
      }
      if (req.method === 'POST' && url.pathname === '/v1/deploy/preview/close') {
        if (!state.previews.delete(body.preview_session_id)) return json(res, { ok: false, error: { code: 'DRAFT_NOT_FOUND', message: 'Preview not found.' } }, 404);
        return json(res, { ok: true, data: { preview_session_id: body.preview_session_id, status: 'closed', cleanup_complete: true } });
      }
      if (req.method === 'POST' && url.pathname === '/v1/promote') {
        const p = state.previews.get(body.preview_session_id);
        if (!p || p.previewId !== body.preview_id) return json(res, { ok: false, error: { code: 'DRAFT_VERSION_MISMATCH', message: 'mismatch' } }, 409);
        state.previews.delete(body.preview_session_id);
        state.seq += 1;
        state.active = `rel_live_${state.seq}`;
        return json(res, { ok: true, data: {
          version: state.seq, release_id: state.active, active_release_id: state.active,
          preview_session_id: body.preview_session_id, preview_id: body.preview_id,
          files_promoted: 1, has_functions: false, preserved_functions: state.preserveOnPromote,
        } });
      }
      if (url.pathname === '/v1/pricing') return json(res, { ok: true, data: { tiers: [] } });
      json(res, { ok: false, error: { code: 'NOT_FOUND', message: url.pathname } }, 404);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    env: (home) => ({ HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1`, SOMEWHERE_MCP_URL: `http://127.0.0.1:${port}/mcp` }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function folder(base = 'rel_live_1') {
  const home = mkdtempSync(join(tmpdir(), 'sw-preview-loop-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-preview-loop-src-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_loop', user: { email: 'loop@example.com' } }) + '\n');
  writeFileSync(join(dir, 'index.html'), '<h1>v1</h1>\n');
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({
    project_id: PROJECT, name: PROJECT, subdomain: 'loop',
    source_base: { project_id: PROJECT, release_id: base, at: new Date().toISOString() },
  }) + '\n');
  return { home, dir };
}

const previewDeploys = (state) => state.requests.filter((r) => r.path === '/v1/deploy' && r.body?.preview);
const record = (dir) => JSON.parse(readFileSync(join(dir, '.somewhere', 'preview.json'), 'utf8'));

test('preview continues the folder\'s open preview, --new opens another, list/close/link work', async () => {
  const platform = await fakePlatform();
  const { home, dir } = folder();
  const env = platform.env(home);
  try {
    const first = await run(['preview', '--once'], dir, env);
    assert.equal(first.status, 0, first.all);
    assert.match(first.all, /Opened preview draft_[0-9a-f-]+ for this folder/);
    const session = record(dir).preview_session_id;
    assert.equal(record(dir).files['index.html'], sha('<h1>v1</h1>\n'), 'the record holds the files as sent');

    writeFileSync(join(dir, 'index.html'), '<h1>v2</h1>\n');
    const second = await run(['preview', '--once'], dir, env);
    assert.equal(second.status, 0, second.all);
    assert.match(second.all, new RegExp(`Continuing this folder's preview ${session} \\(opened 5 min ago, closes in 23 h 55 min if unused\\)`));
    assert.match(second.all, /--new/);
    const sent = previewDeploys(platform.state);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.preview_session_id, session, 'the same session');
    assert.equal(sent[0].body.expected_preview_id, null);
    assert.equal(sent[1].body.expected_preview_id, 'rel_prev_1', 'continues from the preview\'s current version');
    assert.equal(sent[1].body.base_release_id, undefined, 'a continued preview carries no base');
    assert.equal(platform.state.previews.size, 1, 'no second copy of production');
    assert.equal(record(dir).files['index.html'], sha('<h1>v2</h1>\n'));

    const fresh = await run(['preview', '--once', '--new'], dir, env);
    assert.equal(fresh.status, 0, fresh.all);
    assert.equal(platform.state.previews.size, 2, '--new opens a fresh preview');
    assert.notEqual(record(dir).preview_session_id, session);

    const listed = await run(['preview', 'list', '--json'], dir, env);
    assert.equal(listed.status, 0, listed.all);
    const list = JSON.parse(listed.stdout);
    assert.equal(list.previews.length, 2);
    assert.ok(list.previews.every((p) => p.promotable === true && typeof p.age_seconds === 'number' && typeof p.expires_in_seconds === 'number'));
    assert.deepEqual(list.previews.filter((p) => p.this_folder).map((p) => p.preview_session_id), [record(dir).preview_session_id]);
    const human = await run(['preview', 'list'], dir, env);
    assert.match(human.stdout, /CLOSES IN/i);
    assert.match(human.stdout, /rel_prev_\d+/, 'the preview id needed to promote is shown');
    assert.match(human.stdout, /this folder/);
    assert.match(human.stdout, /copy of production data/);

    const link = await run(['preview', 'link', '--json'], dir, env);
    assert.equal(link.status, 0, link.all);
    const linked = JSON.parse(link.stdout);
    assert.equal(linked.preview_session_id, record(dir).preview_session_id, 'link defaults to this folder\'s preview');
    assert.match(linked.url, /__sw_cap\?t=/);

    const closedOld = await run(['preview', 'close', session], dir, env);
    assert.equal(closedOld.status, 0, closedOld.all);
    assert.match(closedOld.all, new RegExp(`Closed preview ${session}\\. Its copy of the production data and files was deleted\\.`));
    const closedMine = await run(['preview', 'close', '--json'], dir, env);
    assert.equal(closedMine.status, 0, closedMine.all);
    assert.equal(JSON.parse(closedMine.stdout).closed[0].data_deleted, true);
    assert.equal(platform.state.previews.size, 0);
    assert.equal(existsSync(join(dir, '.somewhere', 'preview.json')), false, 'closing the folder\'s preview forgets it');
    const none = await run(['preview', 'close'], dir, env);
    assert.equal(none.status, 1);
    assert.match(none.all, /No open preview for this project; nothing was closed/);
  } finally {
    await platform.close();
  }
});

test('a stale folder base is refused before any upload, naming somewhere pull', async () => {
  const platform = await fakePlatform();
  platform.state.active = 'rel_live_9';
  const { home, dir } = folder('rel_live_1');
  try {
    const result = await run(['preview', '--once'], dir, platform.env(home));
    assert.equal(result.status, 1);
    assert.match(result.all, /Production changed since this folder was last pulled or deployed/);
    assert.match(result.all, /somewhere pull/);
    assert.equal(previewDeploys(platform.state).length, 0, 'nothing uploaded');
  } finally {
    await platform.close();
  }
});

test('a recorded preview that production moved past is not continued', async () => {
  const platform = await fakePlatform();
  const { home, dir } = folder();
  const env = platform.env(home);
  try {
    assert.equal((await run(['preview', '--once'], dir, env)).status, 0);
    const old = record(dir).preview_session_id;
    // A deploy from this folder moved production; the folder's base moved with it.
    platform.state.active = 'rel_live_2';
    const config = JSON.parse(readFileSync(join(dir, '.somewhere.json'), 'utf8'));
    config.source_base.release_id = 'rel_live_2';
    writeFileSync(join(dir, '.somewhere.json'), JSON.stringify(config));
    const listed = JSON.parse((await run(['preview', 'list', '--json'], dir, env)).stdout);
    assert.equal(listed.previews[0].promotable, false);
    const next = await run(['preview', '--once'], dir, env);
    assert.equal(next.status, 0, next.all);
    assert.match(next.all, new RegExp(`preview ${old} was opened from an older production version, so it can no longer be promoted`));
    assert.match(next.all, new RegExp(`somewhere preview close ${old}`));
    assert.notEqual(record(dir).preview_session_id, old);
  } finally {
    await platform.close();
  }
});

test('promote of this folder\'s preview moves the folder base; the next preview needs no pull', async () => {
  const platform = await fakePlatform();
  const { home, dir } = folder();
  const env = platform.env(home);
  try {
    assert.equal((await run(['preview', '--once'], dir, env)).status, 0);
    const { preview_session_id: session, preview_id: previewId, files } = record(dir);
    const promoted = await run(['promote', session, previewId, '--yes'], dir, env);
    assert.equal(promoted.status, 0, promoted.all);
    assert.match(promoted.all, /This folder now starts from v2/);
    const config = JSON.parse(readFileSync(join(dir, '.somewhere.json'), 'utf8'));
    assert.equal(config.source_base.release_id, 'rel_live_2');
    const base = JSON.parse(readFileSync(join(dir, '.somewhere', 'base-files.json'), 'utf8'));
    assert.deepEqual([base.release_id, base.files], ['rel_live_2', files], 'pull sees the promoted files as unedited');
    assert.equal(existsSync(join(dir, '.somewhere', 'preview.json')), false);

    const again = await run(['preview', '--once'], dir, env);
    assert.equal(again.status, 0, again.all);
    assert.equal(previewDeploys(platform.state).at(-1).body.base_release_id, 'rel_live_2');
  } finally {
    await platform.close();
  }
});

test('promote of a preview this folder did not make, or with kept functions, leaves the base alone and says so', async () => {
  const platform = await fakePlatform();
  const { home, dir } = folder();
  const env = platform.env(home);
  try {
    assert.equal((await run(['preview', '--once'], dir, env)).status, 0);
    const { preview_session_id: session, preview_id: previewId } = record(dir);
    platform.state.preserveOnPromote = ['api/old.ts'];
    const promoted = await run(['promote', session, previewId, '--yes'], dir, env);
    assert.equal(promoted.status, 0, promoted.all);
    assert.match(promoted.all, /somewhere pull/);
    assert.equal(JSON.parse(readFileSync(join(dir, '.somewhere.json'), 'utf8')).source_base.release_id, 'rel_live_1');
  } finally {
    await platform.close();
  }
});

test('an unknown word after preview is refused, never a new preview', async () => {
  const platform = await fakePlatform();
  const { home, dir } = folder();
  try {
    const result = await run(['preview', 'lsit'], dir, platform.env(home));
    assert.notEqual(result.status, 0);
    assert.match(result.all, /too many arguments|unknown command/i);
    assert.equal(previewDeploys(platform.state).length, 0, 'nothing uploaded, no copy of production made');
  } finally {
    await platform.close();
  }
});
