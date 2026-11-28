import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectFiles } from '../dist/lib/files.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const projectId = 'fixture-blob-project';

test('large deploy uploads missing files and small deploy keeps its request shape', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'deploy-blobs-'));
  const config = join(fixture, 'config');
  const app = join(fixture, 'app');
  mkdirSync(config);
  mkdirSync(join(app, 'public'), { recursive: true });
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'fixture@example.com' } }));
  writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: projectId }));
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>Static fixture</title>');
  const calls = [];
  const objects = new Set();
  let handlerError;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const path = new URL(req.url, 'http://localhost').pathname;
      calls.push(path);
      let data = {};
      if (path === '/v1/deploy/blobs/check') {
        const body = JSON.parse(bytes);
        assert.equal(body.project_id, projectId);
        data = { missing: body.files.map(file => file.sha256).filter(hash => !objects.has(hash)) };
      } else if (path.startsWith('/v1/deploy/blobs/')) {
        const hash = path.split('/').at(-1);
        assert.equal(Number(req.headers['content-length']), bytes.length);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
        objects.add(hash);
      } else if (path === '/v1/deploy') {
        const body = JSON.parse(bytes);
        assert.match(body.files['index.html'], /Static fixture/);
        assert.equal(body.binary_files, undefined);
        for (const digest of Object.values(body.blob_files ?? {})) assert.ok(objects.has(digest.slice(7)));
        data = { version: 1, url: 'https://fixture.somewhere.site', has_functions: false };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, data }));
    } catch (error) {
      handlerError = error;
      res.writeHead(500).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function deploy(enabled, expectedExit = 0) {
    calls.length = 0;
    const started = performance.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'deploy', '--json', '--timing'], {
        cwd: app,
        env: {
          ...process.env, CI: '1', SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_NO_NOTIFICATIONS: '1',
          SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
          SOMEWHERE_DEPLOY_BLOBS: enabled ? '1' : '0',
        },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', status => resolve({ status, stdout, stderr }));
    });
    assert.ifError(handlerError);
    assert.equal(result.status, expectedExit, `${result.stdout}\n${result.stderr}`);
    return { ...result, ms: Math.round(performance.now() - started) };
  }
  try {
    const baseline = await deploy(false);
    const inlineCalls = [...calls];
    const small = await deploy(true);
    assert.deepEqual(calls.sort(), inlineCalls.sort());
    assert.equal(calls.filter(path => path === '/v1/deploy').length, 1);
    assert.ok(calls.every(path => !path.startsWith('/v1/deploy/blobs/')));
    assert.doesNotMatch(small.stderr, /Static file timings/);
    console.log(`Small CLI deploy: baseline ${baseline.ms} ms, pilot ${small.ms} ms.`);

    mkdirSync(join(app, 'src'));
    writeFileSync(join(app, 'src/Player.tsx'), 'export default function Player() { return <video src="/hero.mp4" />; }');
    writeFileSync(join(app, 'public/hero.mp4'), Buffer.alloc(24 * 1024 * 1024));
    for (let index = 0; index < 3000; index++) {
      const bytes = Buffer.alloc(index < 2736 ? 12583 : 12582);
      bytes.writeUInt32LE(index);
      writeFileSync(join(app, `public/${index}.dat`), bytes);
    }
    const first = await deploy(true);
    assert.equal(calls.filter(path => path === '/v1/deploy/blobs/check').length, 1);
    assert.equal(objects.size, 3001);
    assert.equal(JSON.parse(first.stdout).uploaded.static_files.length, 3003);
    assert.match(first.stderr, /Uploading 3001 of 3001/);
    assert.match(first.stderr, /Static file timings .* hash \d+, check \d+, upload \d+/);
    writeFileSync(join(app, 'public/1.dat'), 'replacement');
    const redeploy = await deploy(true);
    assert.match(redeploy.stderr, /Uploading 1 of 3001/);
    assert.equal(objects.size, 3002);
    console.log(`Large CLI deploy: first ${first.ms} ms, one-file redeploy ${redeploy.ms} ms.`);

    writeFileSync(join(app, 'public/too-large.mp4'), Buffer.alloc(26 * 1024 * 1024));
    const refused = await deploy(true, 1);
    assert.match(refused.stdout, /too-large\.mp4.*25 MiB/);
    assert.equal(calls.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('keeps resolved module and CSS assets inline while hashing runtime URLs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-blob-imports-'));
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Assets</title>');
    writeFileSync(join(dir, 'src/Player.tsx'), `
      import icon from './logo.svg';
      export const Player = () => <video src="/hero.mp4" poster="/logo.svg" />;
    `);
    writeFileSync(join(dir, 'src/site.css'), '.logo { background: url(./pattern.png); }');
    writeFileSync(join(dir, 'src/logo.svg'), '<svg/>');
    writeFileSync(join(dir, 'src/pattern.png'), Buffer.from([1]));
    writeFileSync(join(dir, 'public/logo.svg'), '<svg/>');
    writeFileSync(join(dir, 'public/hero.mp4'), Buffer.alloc(12 * 1024 * 1024));
    const files = collectFiles(dir, { deployBlobs: true });
    assert.deepEqual(files.oversize, []);
    assert.deepEqual([...files.blobs.keys()].sort(), ['public/hero.mp4', 'public/logo.svg']);
    assert.ok(files.files['src/logo.svg']);
    assert.ok(files.binaryFiles['src/pattern.png']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
