import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Actual built command against a local HTTP server: list, take and delete call
// the platform's restore point routes and print what the platform returned.
test('db restore-points lists, takes and deletes through the restore point routes', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'cli-db-restore-points-'));
  const requests = [];
  let reply;
  let route = null;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, method: req.method, body: raw ? JSON.parse(raw) : null });
    const r = route ? route(req) : reply;
    if (r.raw) return r.raw(res);
    res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'application/json' });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  async function command(args, sub = ['restore-points', '--project', 'fixture-project']) {
    args = [...sub, ...args];
    const script = `
      import { Command } from 'commander';
      import { registerDb } from './dist/commands/db.js';
      import { saveConfig } from './dist/lib/config.js';
      saveConfig({ token: 'smt_fixture_only', user: { email: 'fixture@example.test' } });
      const p = new Command(); registerDb(p);
      await p.parseAsync(['node', 'somewhere', 'db', ...JSON.parse(process.env.FIXTURE_ARGS)]);
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
  const point = { id: 'rp_fixture', reason: 'deploy', state: 'ready', exact: true, detail: null, taken_at: '2026-11-26T12:00:00.000Z', expires_at: '2026-11-29T12:00:00.000Z', size_bytes: 2_500_000, tables: 2, rows: 40, planes: ['raw', 'managed'] };

  reply = { body: { ok: true, data: { project_id: 'fixture-project', restore_points: [point] } } };
  let r = await command([]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(requests.at(-1), { path: '/v1/db/restore-points?project_id=fixture-project', method: 'GET', body: null });
  assert.match(r.stdout, /rp_fixture.*2026-11-26T12:00:00\.000Z.*deploy.*2\.5 MB.*2026-11-29T12:00:00\.000Z/s);

  // --take starts one in the background and waits until the list shows it ready.
  route = (req) => req.method === 'POST'
    ? { status: 202, body: { ok: true, data: { project_id: 'fixture-project', restore_point: { ...point, reason: 'manual', state: 'running' } } } }
    : { body: { ok: true, data: { project_id: 'fixture-project', restore_points: [{ ...point, reason: 'manual' }] } } };
  r = await command(['--take']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(requests.find((q) => q.method === 'POST' && q.path === '/v1/db/restore-points')?.body, { project_id: 'fixture-project' });
  assert.match(r.stdout + r.stderr, /Restore point rp_fixture taken/);
  route = (req) => req.method === 'POST'
    ? { status: 202, body: { ok: true, data: { project_id: 'fixture-project', restore_point: { ...point, state: 'running' } } } }
    : { body: { ok: true, data: { project_id: 'fixture-project', restore_points: [{ ...point, consistency: 'Each database read in one moment: the SQL tables and the declared tables at different moments.', validation: 'Every table of the database is in the file with every row that was read (2 tables, 40 rows), and every part is stored at its recorded size.' }] } } };
  r = await command(['--take']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /at different moments/, 'take shows how the point was read');
  assert.match(r.stdout + r.stderr, /Every table of the database is in the file/, 'and what was checked');
  r = await command([]);
  assert.match(r.stdout + r.stderr, /rp_fixture: Each database read in one moment: the SQL tables and the declared tables at different moments\./, 'the list shows a split point\'s qualification');
  const history = { ...point, kind: 'history', rows: 0, tables: 0, size_bytes: 0, consistency: 'History points cannot be downloaded or opened as a preview.' };
  route = (req) => req.method === 'POST'
    ? { status: 202, body: { ok: true, data: { restore_point: history } } }
    : { body: { ok: true, data: { restore_points: [{ ...history, state: 'expired' }] } } };
  r = await command(['--take']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /Database history point rp_fixture recorded/);
  assert.doesNotMatch(r.stdout + r.stderr, /1 KB|0 rows/);
  r = await command([]);
  assert.match(r.stdout, /expired/);
  assert.match(r.stdout, /cannot be downloaded or opened as a preview/);
  assert.doesNotMatch(r.stdout, /1 KB/);
  // A point that was not taken says why and fails the command.
  route = (req) => req.method === 'POST'
    ? { status: 202, body: { ok: true, data: { project_id: 'fixture-project', restore_point: { ...point, state: 'running' } } } }
    : { body: { ok: true, data: { project_id: 'fixture-project', restore_points: [{ ...point, state: 'failed', detail: 'COPY_STOPPED: The copy stopped.' }] } } };
  r = await command(['--take']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /No restore point was taken: COPY_STOPPED/);
  route = null;

  reply = { body: { ok: true, data: { project_id: 'fixture-project', deleted: 'rp_fixture' } } };
  r = await command(['--delete', 'rp_fixture']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(requests.at(-1), { path: '/v1/db/restore-points/rp_fixture?project_id=fixture-project', method: 'DELETE', body: null });

  reply = { status: 404, body: { ok: false, error: 'NOT_FOUND', message: 'Endpoint not found.' } };
  const beforeRefusals = requests.length;
  for (const args of [[], ['--take'], ['--delete', 'rp_fixture']]) {
    r = await command(args);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /Endpoint not found\./);
  }
  assert.deepEqual(requests.slice(beforeRefusals).map(({ method }) => method), ['GET', 'POST', 'DELETE']);

  // db dump on a database too large for one response exports in the background and streams the file.
  const ex = { id: 'cp_fixture', state: 'ready', size_bytes: 40, tables: 1, rows: 2, exact: false, detail: null, consistency: 'Read in pages over 3 seconds while the app kept running.' };
  route = (req) => req.url === '/v1/db/dump' ? { status: 413, body: { ok: false, error: 'DUMP_SIZE_LIMIT_EXCEEDED', message: 'too large', data: { background_export: true } } }
    : req.url === '/v1/db/exports' ? { status: 202, body: { ok: true, data: { export: { ...ex, state: 'running' } } } }
    : req.url.startsWith('/v1/db/exports/cp_fixture/sql') ? { type: 'application/sql', body: 'CREATE TABLE t (x);\nINSERT INTO t VALUES (1);\n' }
    : { body: { ok: true, data: { export: ex } } };
  r = await command([], ['dump', '--project', 'fixture-project']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'CREATE TABLE t (x);\nINSERT INTO t VALUES (1);\n', 'stdout is exactly the SQL');
  assert.match(r.stderr, /read in pages|while the app kept running/i);
  assert.deepEqual(requests.find((q) => q.path === '/v1/db/exports')?.body, { project_id: 'fixture-project' });
  route = null;

  // Declared tables too large for one response fall back the same way; the file is private (0600) even when it
  // replaces an existing private backup; the plane is checked before writing; --json needs --output.
  const out = join(home, 'backup.sql');
  writeFileSync(out, 'old'); chmodSync(out, 0o600);
  route = (req) => req.url === '/v1/db/dump' ? { status: 413, body: { ok: false, error: 'EXPORT_SIZE_LIMIT_EXCEEDED', message: 'too large', data: { background_export: true } } }
    : req.url === '/v1/db/exports' ? { status: 202, body: { ok: true, data: { export: { ...ex, plane: 'managed', state: 'running' } } } }
    : req.url.startsWith('/v1/db/exports/cp_fixture/sql') ? { type: 'application/sql', body: 'CREATE TABLE m (x);\n' }
    : { body: { ok: true, data: { export: { ...ex, plane: 'managed' } } } };
  r = await command([], ['dump', '--project', 'fixture-project', '--plane', 'managed', '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, 'utf8'), 'CREATE TABLE m (x);\n');
  assert.equal(statSync(out).mode & 0o777, 0o600, 'the replaced backup stays private');
  assert.deepEqual(readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
  route = (req) => req.url === '/v1/db/dump' ? { status: 413, body: { ok: false, error: 'DUMP_SIZE_LIMIT_EXCEEDED', message: 'too large', data: { background_export: true } } }
    : req.url === '/v1/db/exports' ? { status: 202, body: { ok: true, data: { export: { ...ex, plane: 'managed' } } } }
    : { body: { ok: true, data: { export: { ...ex, plane: 'managed' } } } };
  r = await command([], ['dump', '--project', 'fixture-project', '--output', join(home, 'raw.sql')]);
  assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /export of the managed tables, not the raw ones\. Nothing was written/);
  assert.deepEqual(readdirSync(home).filter((f) => f === 'raw.sql' || f.endsWith('.tmp')), []);
  route = (req) => req.url === '/v1/db/dump' ? { status: 413, body: { ok: false, error: 'DUMP_SIZE_LIMIT_EXCEEDED', message: 'too large', data: { background_export: true } } }
    : req.url.startsWith('/v1/db/exports/cp_fixture/sql') ? { status: 500, body: { ok: false, error: 'INTERNAL_ERROR' } }
    : req.url === '/v1/db/exports' ? { status: 202, body: { ok: true, data: { export: ex } } } : { body: { ok: true, data: { export: ex } } };
  r = await command([], ['dump', '--project', 'fixture-project', '--output', join(home, 'failed.sql')]);
  assert.notEqual(r.status, 0);
  assert.deepEqual(readdirSync(home).filter((f) => f === 'failed.sql' || f.endsWith('.tmp')), [], 'nothing is left behind');
  const before = requests.length;
  route = (req) => req.url === '/v1/db/dump' ? { status: 413, body: { ok: false, error: 'DUMP_SIZE_LIMIT_EXCEEDED', message: 'too large', data: { background_export: true } } } : { body: { ok: true, data: { export: ex } } };
  r = await command([], ['dump', '--project', 'fixture-project', '--json']);
  assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /pass --output <file> with --json/);
  assert.ok(!requests.slice(before).some((q) => q.path === '/v1/db/exports'), 'nothing started');
  route = null;

  // Review 4: background export not offered (the refusal carries no background_export), in every flag
  // combination and plane: the dump's own refusal exactly as sent, no second request, nothing written.
  for (const [code, plane] of [['DUMP_SIZE_LIMIT_EXCEEDED', undefined], ['DUMP_ROW_LIMIT_EXCEEDED', 'raw'], ['EXPORT_SIZE_LIMIT_EXCEEDED', 'managed'], ['EXPORT_ROW_LIMIT_EXCEEDED', 'managed']]) {
    const message = `${code}: the platform's own sentence.`;
    for (const flags of [[], ['--json'], ['--json', '--output', join(home, 'j.sql')], ['--output', join(home, 'o.sql')]]) {
      const start = requests.length;
      route = () => ({ status: 413, body: { ok: false, error: code, message } });
      r = await command([], ['dump', '--project', 'fixture-project', ...(plane ? ['--plane', plane] : []), ...flags]);
      const label = `${code} ${plane ?? '(default plane)'} ${flags.join(' ') || '(no flags)'}`;
      assert.notEqual(r.status, 0, label);
      assert.ok((r.stdout + r.stderr).includes(`${code}: ${message}`), `${label}: ${r.stdout + r.stderr}`);
      assert.doesNotMatch(r.stdout + r.stderr, /--output|Endpoint not found|FORBIDDEN|background/i, label);
      assert.deepEqual(requests.slice(start).map((q) => q.path), ['/v1/db/dump'], `${label}: one request`);
      assert.deepEqual(readdirSync(home).filter((f) => ['j.sql', 'o.sql'].includes(f) || f.endsWith('.tmp')), [], label);
    }
  }
  route = null;

  // Background exports not offered for this project (the platform answers 404): the dump's own refusal, as before.
  route = (req) => req.url === '/v1/db/dump' ? { status: 413, body: { ok: false, error: 'DUMP_SIZE_LIMIT_EXCEEDED', message: 'The SQL tables are larger than one dump holds.', data: { background_export: true } } }
    : { status: 404, body: { ok: false, error: 'NOT_FOUND', message: 'Endpoint not found.' } };
  r = await command([], ['dump', '--project', 'fixture-project', '--output', join(home, 'off.sql')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /DUMP_SIZE_LIMIT_EXCEEDED: The SQL tables are larger than one dump holds\./);
  assert.doesNotMatch(r.stdout + r.stderr, /Endpoint not found/);
  assert.deepEqual(readdirSync(home).filter((f) => f === 'off.sql' || f.endsWith('.tmp')), []);
  // Review 3: a download interrupted mid-stream (some bytes written, then the connection drops) leaves no file.
  route = (req) => req.url === '/v1/db/dump' ? { status: 413, body: { ok: false, error: 'DUMP_SIZE_LIMIT_EXCEEDED', message: 'too large', data: { background_export: true } } }
    : req.url.startsWith('/v1/db/exports/cp_fixture/sql') ? { raw: (res) => { res.writeHead(200, { 'content-type': 'application/sql', 'content-length': '100000' }); res.write('CREATE TABLE t (x);\n'.repeat(50)); setTimeout(() => res.destroy(), 50); } }
    : req.url === '/v1/db/exports' ? { status: 202, body: { ok: true, data: { export: ex } } } : { body: { ok: true, data: { export: ex } } };
  r = await command([], ['dump', '--project', 'fixture-project', '--output', join(home, 'cut.sql')]);
  assert.notEqual(r.status, 0, 'an interrupted download fails the command');
  assert.deepEqual(readdirSync(home).filter((f) => f === 'cut.sql' || f.endsWith('.tmp')), [], 'and leaves neither the file nor its temporary');
  route = null;

  reply = { body: { ok: true, data: { confirmed: false, app: 'fixture-app', point_id: 'rp_history',
    expires_at: '2026-12-01', moments: [{ plane: 'raw', at: '2026-11-27' }], warning: 'Database requests may fail.' } } };
  r = await command(['--restore', 'rp_history']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Database requests may fail/);
  assert.deepEqual(requests.at(-1), { path: '/v1/db/restore-points/rp_history/restore', method: 'POST', body: { project_id: 'fixture-project' } });
  reply = { body: { ok: true, data: { confirmed: true, undo_point_id: 'rp_undo' } } };
  r = await command(['--restore', 'rp_history', '--confirm-app', 'fixture-app']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Undo point: rp_undo/);
  assert.deepEqual(requests.at(-1).body.confirm, { app: 'fixture-app', point: 'rp_history' });
  reply = { body: { ok: true, data: { restore_points: [], restore: { point_id: 'rp_history', message: 'Restore outcome unknown.' } } } };
  r = await command([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /rp_history: Restore outcome unknown/);

  reply = { status: 403, body: { ok: false, error: 'OWNER_REQUIRED', message: 'Only the project owner can take, list or delete database restore points. Nothing changed.' } };
  r = await command([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /project owner/);
});
