import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Directed evidence through the real `somewhere preview` watch loop, against
// local stubs only: a valid first preview, then a save that grows a file past
// the per-file limit (refused, no patch, last preview kept), then a save that
// shrinks it (one patch carrying the held changes). A large file the project
// ignores stays out throughout.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const PROJECT = 'proj_preview_fixture';
const patches = [];
const deploys = [];

// Platform tools (MCP): preview access and deployment status.
const mcp = createServer(async (req, res) => {
  const server = new Server({ name: 'stub', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const data = request.params.name === 'project_get'
      ? { id: PROJECT, cloud_dev_allowed: true }
      : { project_id: PROJECT, active_release_id: 'rel_live', preview_candidates: [] };
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined); });
});
// REST API.
const api = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = req.url.split('?')[0];
    const send = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data })); };
    if (req.method === 'POST' && path === '/v1/deploy') {
      const parsed = JSON.parse(body); deploys.push(parsed);
      return send({ preview_session_id: parsed.preview_session_id, preview_id: 'cand_1', preview_url: 'https://fixture-dev.example.test' });
    }
    if (req.method === 'POST' && path === '/v1/deploy/patch') {
      const parsed = JSON.parse(body); patches.push(parsed);
      return send({ preview_session_id: parsed.preview_session_id, preview_id: `cand_${patches.length + 1}` });
    }
    if (req.method === 'POST' && path === `/v1/projects/${PROJECT}/preview/mint`) return send({ preview_url: 'https://fixture-dev.example.test/__sw_cap?t=fixture' });
    send({ notices: [] });
  });
});
await Promise.all([mcp, api].map((s) => new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))));
test.after(() => { mcp.closeAllConnections?.(); api.closeAllConnections?.(); mcp.close(); api.close(); });

const until = async (check, what, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('preview watch loop: oversize save refused with no patch and the last preview kept; shrink sends one patch with the held changes', { skip: process.platform === 'win32' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'sw-preview-watch-'));
  const app = join(base, 'app'), config = join(base, 'config');
  mkdirSync(join(app, 'public', 'data'), { recursive: true }); mkdirSync(config);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'dev@example.test', username: 'dev' } }));
  writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: PROJECT, name: 'Fixture', subdomain: 'fixture',
    source_base: { project_id: PROJECT, release_id: 'rel_live', at: new Date().toISOString() } }));
  writeFileSync(join(app, '.somewhereignore'), 'public/data/huge.json\n');
  writeFileSync(join(app, 'index.html'), '<html><body>v1</body></html>\n');
  writeFileSync(join(app, 'public', 'hero.png'), Buffer.alloc(1024, 1));

  const child = spawn(process.execPath, [cli, 'preview'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: `http://127.0.0.1:${api.address().port}/v1`,
    SOMEWHERE_MCP_URL: `http://127.0.0.1:${mcp.address().port}/mcp`, SOMEWHERE_PREVIEW_POLL_MS: '600000',
    BROWSER: '/usr/bin/false', SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
  } });
  let out = '';
  child.stdout.on('data', (v) => { out += v; }); child.stderr.on('data', (v) => { out += v; });
  try {
    await until(() => /to preview/.test(out), 'the first preview sync');
    assert.equal(deploys.length, 1, out);
    assert.ok(!Object.keys(deploys[0].binary_files ?? {}).some((k) => k.includes('huge')), 'ignored file not in the first sync');
    await new Promise((r) => setTimeout(r, 1500)); // watcher ready

    // Save 1: the image grows past the limit, beside an ordinary edit.
    writeFileSync(join(app, 'index.html'), '<html><body>v2</body></html>\n');
    writeFileSync(join(app, 'public', 'hero.png'), Buffer.alloc(6 * 1024 * 1024, 1));
    await until(() => /Nothing in this save was sent/.test(out), 'the size refusal');
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(patches.length, 0, 'no patch for a refused save');
    assert.match(out, /public\/hero\.png \(6\.0 MB\)/);
    assert.match(out, /Your last preview is unchanged/);

    // Save 2: the image shrinks; an ignored large file changes too.
    writeFileSync(join(app, 'public', 'data', 'huge.json'), 'x'.repeat(6 * 1024 * 1024));
    writeFileSync(join(app, 'public', 'hero.png'), Buffer.alloc(2048, 1));
    await until(() => patches.length >= 1, 'the patch after the shrink');
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(patches.length, 1, 'exactly one patch');
    const [patch] = patches;
    assert.equal(patch.expected_preview_id, 'cand_1', 'built on the retained last preview');
    assert.deepEqual(Object.keys(patch.update_files ?? {}), ['index.html'], 'the held edit is sent');
    assert.match(patch.update_files['index.html'], /v2/);
    assert.deepEqual(Object.keys(patch.update_binary_files ?? {}), ['hero.png']);
    assert.equal(Buffer.from(patch.update_binary_files['hero.png'], 'base64').length, 2048);
    assert.ok(!JSON.stringify(Object.keys(patch)).includes('huge') && !JSON.stringify(patch.update_files ?? {}).includes('huge.json'), 'the ignored file stays out');
  } finally {
    child.kill('SIGINT');
    await new Promise((r) => child.on('close', r));
  }
});
