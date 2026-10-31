import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// pfb_7b36450727ee: a bad `logs --tail` is refused, not silently replaced; an
// --include entry or "!" line that cannot publish what it names says so. The
// upload policy is unchanged: nothing it held back is published.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const requests = [];
const dryRun = { dry_run: true, project_id: 'proj_fixture', current_version: 1, expected_version: null, version_conflict: false,
  static_files: { added: [], modified: [], unchanged: [], removed: [], added_count: 0, modified_count: 0, removed_count: 0 }, functions: { added: [], modified: [], removed: [] }, warnings: [] };
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url !== '/') requests.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: req.method === 'POST' && req.url.startsWith('/v1/deploy') ? dryRun : { logs: [] } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

function run(args, files = {}) {
  requests.length = 0;
  const base = mkdtempSync(join(tmpdir(), 'sw-notes-'));
  const app = join(base, 'app'), config = join(base, 'config');
  mkdirSync(app); mkdirSync(config);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'dev@example.test', username: 'dev' } }));
  writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: 'proj_fixture', name: 'Fixture', subdomain: 'fixture' }));
  writeFileSync(join(app, 'index.html'), '<html></html>\n');
  writeFileSync(join(base, 'outside.txt'), 'outside the project\n');
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(app, path)), { recursive: true }); writeFileSync(join(app, path), content); }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args.map((a) => a.replace('<BASE>', base))], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr }));
  });
}

for (const tail of ['abc', '-5', '0', '2.5', '9007199254740993', '99999999999999999999999', '1e3']) {
  test(`logs --tail ${tail} is refused before any request`, async () => {
    const result = await run(['logs', '--tail', tail]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /--tail must be a whole number of lines, from 1 to 9007199254740991/);
    assert.deepEqual(requests, []);
  });
}

for (const tail of ['50', '9007199254740991']) {
  test(`logs --tail ${tail} asks for exactly ${tail}`, async () => {
    const result = await run(['logs', '--tail', tail]);
    assert.equal(result.status, 0, result.out);
    assert.match(requests[0].url, new RegExp(`[?&]limit=${tail}(&|$)`));
  });
}

test('--include entries and "!" lines that cannot publish what they name say so; nothing new is uploaded', async () => {
  const result = await run(['deploy', '--dry-run', '--json',
    '--include', 'missing.txt', '--include', '.env', '--include', '../outside.txt', '--include', '<BASE>/outside.txt', '--include', 'secret-notes.md',
    '--include', 'NOTES.md'], {
    '.env': 'SECRET=FAKE\n', 'NOTES.md': 'planning\n', 'secret-notes.md': 'kept out\n',
    '.gitignore': 'secret-notes.md\n', '.somewhereignore': '!.env\n!NOTES.md\n',
  });
  assert.equal(result.status, 0, result.out);
  const notes = result.stderr.split('\n').filter((line) => line.startsWith('no effect: '));
  assert.deepEqual(notes.map((line) => line.split(' — ')[0]).sort(), [
    'no effect: --include ../outside.txt', 'no effect: --include .env', `no effect: --include ${result.stderr.match(/--include (\/\S+outside\.txt)/)[1]}`,
    'no effect: --include missing.txt', 'no effect: --include secret-notes.md', 'no effect: .somewhereignore line "!.env"',
  ].sort());
  assert.match(result.stderr, /--include missing\.txt — there is no such file or folder in this project/);
  assert.match(result.stderr, /--include \.\.\/outside\.txt — it is outside this project folder/);
  assert.match(result.stderr, /--include secret-notes\.md — it is kept out by \.gitignore or \.somewhereignore/);
  const sent = Object.keys(JSON.parse(requests.find((r) => r.url.startsWith('/v1/deploy')).body).files ?? {});
  assert.ok(sent.includes('NOTES.md'), 'a legitimate --include still publishes');
  assert.ok(!sent.some((p) => /env|outside|secret-notes|missing/.test(p)), sent.join(','));
  assert.doesNotMatch(result.stderr, /--include NOTES\.md|"!NOTES\.md"/, 'an opt-in that worked gets no note');
});
