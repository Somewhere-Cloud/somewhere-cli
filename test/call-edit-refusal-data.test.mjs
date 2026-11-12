//  follow-up: a typed ordered-edit refusal keeps its handles through
// `somewhere call`. The MCP response carries data.edit_index / path / expected /
// actual / conflicts_with; --json printed the code and message but dropped them,
// and text output never showed them. Only these validated fields are kept: a
// planted value in any other data field, or a malformed edit field, never prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const CANARY = 'canary-password-hunter2 smt_CANARYdevkey0000000000000000';

const refusal = (error, data, message = `${error} fixture`) => ({
  ok: false, error, message, http_status: error === 'FILE_NOT_FOUND' ? 404 : 400, data,
});

test('call keeps the validated edit-refusal fields in --json and text output, and nothing else', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'sw-call-edit-'));
  const config = join(scratch, 'config');
  const app = join(scratch, 'app');
  mkdirSync(config);
  mkdirSync(app);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_call_edit_fixture' }));
  let next = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const rpc = JSON.parse(body);
      let result = {};
      if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      if (rpc.method === 'tools/list') result = { tools: [{ name: 'project_patch', inputSchema: { type: 'object', properties: {} } }] };
      if (rpc.method === 'tools/call') result = { isError: true, content: [{ type: 'text', text: JSON.stringify(next) }] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', ...(rpc.id !== undefined ? { id: rpc.id } : {}), result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_MCP_URL: `${base}/mcp`, SOMEWHERE_API_URL: `${base}/v1`, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', NO_COLOR: '1' };
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: app, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const call = (json) => run(['call', 'project_patch', '{"project_id":"p","edits":[]}', ...(json ? ['--json'] : [])]);
  try {
    const cases = [
      {
        name: 'late match failure names its edit',
        envelope: refusal('FIND_NOT_FOUND', { edit_index: 2, path: 'index.html', current_length: 42, closest_match: { offset: 3, snippet: CANARY }, private: CANARY }),
        data: { edit_index: 2, path: 'index.html' },
        line: 'edit_index 2 · path index.html',
      },
      {
        name: 'expect mismatch keeps expected and actual',
        envelope: refusal('FIND_COUNT_MISMATCH', { edit_index: 0, path: 'src/App.tsx', expected: 1, actual: 2 }),
        data: { edit_index: 0, path: 'src/App.tsx', expected: 1, actual: 2 },
        line: 'edit_index 0 · path src/App.tsx · expected 1 · actual 2',
      },
      {
        name: 'conflicting path names the other input',
        envelope: refusal('VALIDATION_ERROR', { edit_index: 1, path: 'api/[id].ts', conflicts_with: 'delete_files' }),
        data: { edit_index: 1, path: 'api/[id].ts', conflicts_with: 'delete_files' },
        line: 'edit_index 1 · path api/[id].ts · conflicts_with delete_files',
      },
    ];
    for (const c of cases) {
      await t.test(`${c.name} (--json)`, async () => {
        next = c.envelope;
        const r = await call(true);
        assert.equal(r.status, 1);
        const out = JSON.parse(r.stdout);
        assert.equal(out.error, c.envelope.error);
        assert.deepEqual(out.data, c.data);
        assert.ok(!r.stdout.includes('canary'), 'no unvalidated data field is printed');
      });
      await t.test(`${c.name} (text)`, async () => {
        next = c.envelope;
        const r = await call(false);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes(c.line), r.stderr);
        assert.ok(!r.stderr.includes('canary'));
      });
    }

    await t.test('malformed edit fields are dropped rather than printed', async () => {
      next = refusal('FIND_COUNT_MISMATCH', { edit_index: '2', path: `index.html ${CANARY}`, expected: -1, actual: 1.5, conflicts_with: CANARY });
      const r = await call(true);
      assert.equal(JSON.parse(r.stdout).data, undefined);
      next = refusal('FIND_COUNT_MISMATCH', { edit_index: 3, path: `../${CANARY}`, expected: 'one', conflicts_with: 'files_map' });
      const r2 = await call(true);
      assert.deepEqual(JSON.parse(r2.stdout).data, { edit_index: 3 });
      assert.ok(!r.stdout.includes('canary') && !r2.stdout.includes('canary'));
    });

    await t.test('an error without edit fields prints no detail line', async () => {
      next = refusal('STALE_RELEASE_BASE', { path: 'index.html', active_release_id: 'rel_2' });
      const r = await call(false);
      assert.equal(r.status, 1);
      assert.ok(!/edit_index|path index\.html/.test(r.stderr), r.stderr);
    });
  } finally {
    server.close();
  }
});
