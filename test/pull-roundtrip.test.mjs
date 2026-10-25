import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const source = {
  project_id: 'proj_roundtrip', env: 'prod', version: 7, active_release_id: 'rel_exported',
  static_files: {
    'index.html': '<html><body>roundtrip</body></html>',
    'src/value.ts': 'export const value = 7;\n',
    'db/schema.ts': 'export const tables = {};\n',
  },
  binary_files: { 'logo.png': Buffer.from([137, 80, 78, 71]).toString('base64') },
  functions: { 'api/read.ts': "import { value } from '../src/value'; export default () => Response.json({ value });\n", '_lib/helper.ts': 'export const helper = 1;\n' },
  counts: { static_files: 3, binary_files: 1, functions: 2 },
};
function run(args, cwd, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
    let output = '';
    child.stdout.on('data', c => output += c);
    child.stderr.on('data', c => output += c);
    child.on('close', status => resolve({ status, output }));
  });
}
async function fixture(fn, exported = source) {
  const root = mkdtempSync(join(tmpdir(), 'sw-pull-roundtrip-'));
  const app = join(root, 'app'); const config = join(root, 'config');
  mkdirSync(app); mkdirSync(config);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'test@example.com', username: 'test' } }));
  const uploads = [];
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const send = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); };
      if (url.pathname.endsWith('/deploy/source')) return send(exported);
      if (req.method === 'POST' && url.pathname.endsWith('/deploy')) {
        uploads.push(JSON.parse(raw));
        return send({ version: 8, active_release_id: 'rel_next', files: 4, url: 'https://fixture.somewhere.site', has_functions: true });
      }
      res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND', message: req.url }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { SOMEWHERE_CONFIG_DIR: config, SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1` };
  try { await fn({ root, app, env, uploads }); } finally { await new Promise(r => server.close(r)); }
}

test('fresh pull restores normal paths, exact source/assets/schema, and ordinary deploy uses the exported project/base', async () => {
  await fixture(async ({ app, env, uploads }) => {
    let result = await run(['pull', 'named-project'], app, env);
    assert.equal(result.status, 0, result.output);
    assert.equal(existsSync(join(app, 'functions')), false);
    for (const [path, contents] of Object.entries({ ...source.static_files, ...source.functions })) assert.equal(readFileSync(join(app, path), 'utf8'), contents);
    assert.deepEqual(readFileSync(join(app, 'logo.png')), Buffer.from(source.binary_files['logo.png'], 'base64'));
    const link = JSON.parse(readFileSync(join(app, '.somewhere.json'), 'utf8'));
    assert.equal(link.project_id, source.project_id);
    assert.equal(link.source_base.release_id, source.active_release_id);
    result = await run(['deploy', '--json'], app, env);
    assert.equal(result.status, 0, result.output);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].project_id, source.project_id);
    assert.equal(uploads[0].base_release_id, source.active_release_id);
    assert.deepEqual(uploads[0].functions, source.functions);
    assert.equal(uploads[0].files['db/schema.ts'], source.static_files['db/schema.ts']);
    assert.equal(uploads[0].binary_files['logo.png'], source.binary_files['logo.png']);
  });
});

test('different linked project is preserved even with force', async () => {
  await fixture(async ({ app, env }) => {
    const config = '{"project_id":"other","name":"other","subdomain":"other"}';
    writeFileSync(join(app, '.somewhere.json'), config);
    const result = await run(['pull', 'named-project', '--force'], app, env);
    assert.equal(result.status, 1, result.output);
    assert.equal(readFileSync(join(app, '.somewhere.json'), 'utf8'), config);
    assert.equal(existsSync(join(app, 'index.html')), false);
  });
});

test('conflicts fail before writing any source or link', async () => {
  for (const conflict of ['file', 'directory', 'symlink']) await fixture(async ({ root, app, env }) => {
    if (conflict === 'file') { mkdirSync(join(app, 'api')); writeFileSync(join(app, 'api/read.ts'), 'local change'); }
    if (conflict === 'directory') mkdirSync(join(app, 'api/read.ts'), { recursive: true });
    if (conflict === 'symlink') symlinkSync(root, join(app, 'api'));
    const result = await run(['pull', 'named-project'], app, env);
    assert.equal(result.status, 1, result.output);
    assert.equal(existsSync(join(app, 'index.html')), false);
    assert.equal(existsSync(join(app, '.somewhere.json')), false);
    if (conflict === 'file') assert.equal(readFileSync(join(app, 'api/read.ts'), 'utf8'), 'local change');
  });
});

test('preview source records its confirmed base, never the current production pointer', async () => {
  await fixture(async ({ app, env }) => {
    const result = await run(['pull', 'named-project', '--env', 'dev'], app, env);
    assert.equal(result.status, 0, result.output);
    const config = JSON.parse(readFileSync(join(app, '.somewhere.json'), 'utf8'));
    assert.equal(config.source_base.release_id, 'rel_preview_base');
    assert.equal(config.last_deploy, undefined);
  }, { ...source, env: 'dev', source_release_id: 'rel_preview', base_release_id: 'rel_preview_base' });
});

test('ambiguous export paths are rejected before source/link writes', async () => {
  for (const functions of [
    { 'api/read.ts': source.functions['api/read.ts'], '../escape.ts': 'escape' },
    { 'api': 'parent file', 'api/read.ts': 'child' },
  ]) await fixture(async ({ app, env }) => {
    const result = await run(['pull', 'named-project'], app, env);
    assert.equal(result.status, 1, result.output);
    assert.equal(existsSync(join(app, 'index.html')), false);
    assert.equal(existsSync(join(app, '.somewhere.json')), false);
  }, { ...source, functions, static_files: { ...source.static_files, 'functions/api': 'collision' } });
});

test('pull --out links only the output directory and keeps its confirmed exported base', async () => {
  await fixture(async ({ app, env }) => {
    const parentConfig = '{"project_id":"parent","name":"parent","subdomain":"parent"}';
    writeFileSync(join(app, '.somewhere.json'), parentConfig);
    const result = await run(['pull', 'named-project', '--out', 'download'], app, env);
    assert.equal(result.status, 0, result.output);
    assert.equal(readFileSync(join(app, '.somewhere.json'), 'utf8'), parentConfig);
    const config = JSON.parse(readFileSync(join(app, 'download/.somewhere.json'), 'utf8'));
    assert.equal(config.project_id, source.project_id);
    assert.equal(config.source_base.release_id, source.active_release_id);
  });
});
