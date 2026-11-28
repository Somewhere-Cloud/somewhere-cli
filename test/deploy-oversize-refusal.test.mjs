import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A deploy is a full replacement: a published file left out for size would
// delete its live copy. Such a file refuses the deploy before any request.
// Deliberate exclusions (ignore files, local notes) are not refused.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const requests = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ method: req.method, path: req.url.split('?')[0], body });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url.startsWith('/v1/deploy')) {
      // The platform's dry-run success shape (worker/src/routes/deploy/orchestration.ts).
      return res.end(JSON.stringify({ ok: true, data: { dry_run: true, project_id: 'proj_fixture', current_version: 1, expected_version: null, version_conflict: false,
        static_files: { added: ['index.html'], modified: [], unchanged: [], removed: [], added_count: 1, modified_count: 0, removed_count: 0 },
        functions: { added: [], modified: [], removed: [] }, warnings: [] } }));
    }
    res.end(JSON.stringify({ ok: true, data: {} }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

const BIG = 6 * 1024 * 1024;
function project(extra) {
  const base = mkdtempSync(join(tmpdir(), 'swtest-oversize-'));
  const app = join(base, 'app'), config = join(base, 'config');
  mkdirSync(join(app, 'public'), { recursive: true }); mkdirSync(config);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'dev@example.test', username: 'dev' } }));
  writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: 'proj_fixture', name: 'swtest-oversize', subdomain: 'swtest-oversize' }));
  writeFileSync(join(app, 'index.html'), '<html><body>hi</body></html>\n');
  for (const [path, content] of Object.entries(extra)) {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    writeFileSync(join(app, path), content);
  }
  return { app, config };
}
function run(args, { app, config }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
    child.on('close', (status) => resolve({ status, stdout, stderr, out: stdout + stderr }));
  });
}

for (const args of [['deploy'], ['deploy', '--dry-run'], ['deploy', '--force', '--yes']]) {
  test(`\`${args.join(' ')}\`: a published file over the limit refuses before any request`, async () => {
    requests.length = 0;
    const result = await run(args, project({ 'public/big.bin': Buffer.alloc(BIG, 1) }));
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /Nothing was sent\. This file is over the 5\.0 MB per-file limit/);
    assert.match(result.out, /public\/big\.bin \(6\.0 MB\)/);
    assert.match(result.out, /somewhere fs put public\/big\.bin big\.bin/);
    assert.deepEqual(requests, []);
  });
}

test('--json refuses with FILE_TOO_LARGE and sends nothing', async () => {
  requests.length = 0;
  const result = await run(['deploy', '--json'], project({ 'public/big.bin': Buffer.alloc(BIG, 1) }));
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error, 'FILE_TOO_LARGE');
  assert.deepEqual(requests, []);
});

test('preview refuses the same way before any request', async () => {
  requests.length = 0;
  const result = await run(['preview', '--once'], project({ 'public/big.bin': Buffer.alloc(BIG, 1) }));
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /per-file limit/);
  assert.deepEqual(requests.filter((r) => r.method !== 'GET' || !r.path.includes('/notices')), []);
});

test('a large file kept out on purpose (.somewhereignore) and a large local note do not refuse; .well-known still ships', async () => {
  requests.length = 0;
  const result = await run(['deploy', '--dry-run'], project({
    'public/big.bin': Buffer.alloc(BIG, 1), '.somewhereignore': 'public/big.bin\n',
    'transcript.log': 'x'.repeat(BIG), 'public/.well-known/security.txt': 'Contact: mailto:security@example.test\n',
  }));
  assert.equal(result.status, 0, result.out);
  assert.doesNotMatch(result.out, /per-file limit/);
  const deploy = requests.find((r) => r.method === 'POST' && r.path === '/v1/deploy');
  assert.ok(deploy, JSON.stringify(requests.map((r) => r.path)));
  const body = JSON.parse(deploy.body);
  assert.equal(body.dry_run, true);
  const sent = [...Object.keys(body.files ?? {}), ...Object.keys(body.binary_files ?? {})];
  assert.ok(sent.includes('public/.well-known/security.txt'), sent.join(','));
  assert.ok(!sent.some((p) => p.includes('big.bin') || p.includes('transcript.log')), sent.join(','));
});

test('a 39 MiB tree of individually allowed files is refused before any request', async () => {
  requests.length = 0;
  const files = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [
    `public/fixture-${i}.${i % 2 ? 'txt' : 'bin'}`, Buffer.alloc(3 * 1024 * 1024, 65),
  ]));
  const result = await run(['deploy', '--json'], project(files));
  assert.equal(result.status, 1, result.out);
  const output = JSON.parse(result.stdout);
  assert.equal(output.error, 'DEPLOY_TOO_LARGE');
  assert.equal(output.limit_bytes, 20 * 1024 * 1024);
  assert.match(output.message, /39\.0 MiB.*20 MiB/);
  assert.deepEqual(requests, []);
});

test('worker-stripped README selected via --include does not inflate the 20 MiB precheck', async () => {
  requests.length = 0;
  const files = Object.fromEntries(Array.from({ length: 19 }, (_, i) => [
    `public/fixture-${i}.bin`, Buffer.alloc(1024 * 1024, 65),
  ]));
  const result = await run(['deploy', '--dry-run', '--include', 'README.md', '--json'], project({
    ...files, 'README.md': 'x'.repeat(2 * 1024 * 1024),
  }));
  assert.equal(result.status, 0, result.out);
  const request = requests.find(r => r.method === 'POST' && r.path === '/v1/deploy');
  assert.equal(JSON.parse(request.body).files['README.md'].length, 2 * 1024 * 1024);
});

test('deploy preserves literal U+FFFD text and sends DOCX and unknown binary files as bytes', async () => {
  requests.length = 0;
  const js = 'console.log("�");\n';
  const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff]);
  const unknown = Buffer.from([0xc3, 0x28]);
  const result = await run(['deploy', '--dry-run'], project({
    'public/main.js': js, 'public/guide.docx': docx, 'public/download.dat': unknown,
  }));
  assert.equal(result.status, 0, result.out);
  const body = JSON.parse(requests.find((r) => r.method === 'POST' && r.path === '/v1/deploy').body);
  assert.equal(body.files['public/main.js'], js);
  assert.equal(body.binary_files['public/guide.docx'], docx.toString('base64'));
  assert.equal(body.binary_files['public/download.dat'], unknown.toString('base64'));
});
