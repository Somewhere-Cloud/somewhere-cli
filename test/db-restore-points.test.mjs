import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Actual built command against a local HTTP server: list, take and delete call
// the platform's restore point routes and print what the platform returned.
test('db restore-points lists, takes and deletes through the restore point routes', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cli-db-restore-points-'));
  const requests = [];
  let reply;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, method: req.method, body: raw ? JSON.parse(raw) : null });
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  async function command(args) {
    const script = `
      import { Command } from 'commander';
      import { registerDb } from './dist/commands/db.js';
      import { saveConfig } from './dist/lib/config.js';
      saveConfig({ token: 'smt_fixture_only', user: { email: 'fixture@example.test' } });
      const p = new Command(); registerDb(p);
      await p.parseAsync(['node', 'somewhere', 'db', 'restore-points', '--project', 'fixture-project', ...JSON.parse(process.env.FIXTURE_ARGS)]);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, HOME: home, USERPROFILE: home,
        SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
        FIXTURE_ARGS: JSON.stringify(args), NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
    return { status, stdout, stderr };
  }
  const point = { id: 'rp_fixture', reason: 'deploy', taken_at: '2026-11-26T12:00:00.000Z', expires_at: '2026-11-29T12:00:00.000Z', size_bytes: 2_500_000, tables: 2, rows: 40, planes: ['raw', 'managed'] };

  reply = { body: { ok: true, data: { project_id: 'fixture-project', restore_points: [point] } } };
  let r = await command([]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(requests.at(-1), { path: '/v1/db/restore-points?project_id=fixture-project', method: 'GET', body: null });
  assert.match(r.stdout, /rp_fixture.*2026-11-26T12:00:00\.000Z.*deploy.*2\.5 MB.*2026-11-29T12:00:00\.000Z/s);

  reply = { body: { ok: true, data: { project_id: 'fixture-project', restore_point: { ...point, reason: 'manual' } } } };
  r = await command(['--take']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(requests.at(-1), { path: '/v1/db/restore-points', method: 'POST', body: { project_id: 'fixture-project' } });
  assert.match(r.stdout + r.stderr, /Restore point rp_fixture taken/);

  reply = { body: { ok: true, data: { project_id: 'fixture-project', deleted: 'rp_fixture' } } };
  r = await command(['--delete', 'rp_fixture']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(requests.at(-1), { path: '/v1/db/restore-points/rp_fixture?project_id=fixture-project', method: 'DELETE', body: null });

  reply = { status: 403, body: { ok: false, error: 'OWNER_REQUIRED', message: 'Only the project owner can take, list or delete database restore points. Nothing changed.' } };
  r = await command([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /project owner/);
});
