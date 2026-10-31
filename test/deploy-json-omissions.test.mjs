import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `deploy --json`: stdout is the deploy result alone (unchanged contract), and
// every file the CLI left out locally is named on stderr with its reason, never
// its contents, in a fixed order.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const dryRun = { dry_run: true, project_id: 'proj_fixture', current_version: 1, expected_version: null, version_conflict: false,
  static_files: { added: ['index.html'], modified: [], unchanged: [], removed: [], added_count: 1, modified_count: 0, removed_count: 0 },
  functions: { added: [], modified: [], removed: [] }, warnings: [] };
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, data: req.method === 'POST' && req.url.startsWith('/v1/deploy') ? dryRun : {} }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

function run(args, files) {
  const base = mkdtempSync(join(tmpdir(), 'sw-json-omit-'));
  const app = join(base, 'app'), config = join(base, 'config');
  mkdirSync(app); mkdirSync(config);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'dev@example.test', username: 'dev' } }));
  writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: 'proj_fixture', name: 'Fixture', subdomain: 'fixture' }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    if (content === null) symlinkSync('/etc/hosts', join(app, path));
    else writeFileSync(join(app, path), content);
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('--json names every local omission on stderr and leaves stdout as the deploy result', async () => {
  const secret = 'FAKE_PRIVATE_KEY_MATERIAL_do_not_print';
  const result = await run(['deploy', '--dry-run', '--json'], {
    'index.html': '<html><body>hi</body></html>\n',
    'NOTES.md': 'private planning notes FAKE_NOTE_TEXT\n',
    'api/hello.test.ts': 'export {};\n',
    'id_rsa': secret,
    'public/linked.txt': null,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), dryRun);
  const lines = result.stderr.trim().split('\n').filter((line) => /^(not published|never uploaded|not uploaded): /.test(line));
  assert.deepEqual(lines.map((line) => line.split(' — ')[0]), [
    'not published: api/hello.test.ts',
    'not published: NOTES.md',
    'never uploaded: id_rsa',
    'not uploaded: public/linked.txt',
  ]);
  assert.doesNotMatch(result.stderr, /FAKE_PRIVATE_KEY_MATERIAL|FAKE_NOTE_TEXT/);
});

test('--json with nothing left out prints nothing extra on stderr', async () => {
  const result = await run(['deploy', '--dry-run', '--json'], { 'index.html': '<html><body>hi</body></html>\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), dryRun);
  assert.doesNotMatch(result.stderr, /not published|never uploaded|not uploaded/);
});
