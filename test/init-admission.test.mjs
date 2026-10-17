// Which directories `somewhere init` writes a starter into, links as existing
// source, or refuses, decided before any request (pfb_82e8752b7581). A
// fixture API refuses every call and records it, so "nothing was created" is
// the recorded request list, never a real project.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = Boolean(process.env.SOMEWHERE_TEST_SOURCE);
const moduleRoot = source ? '../src' : '../dist';
const ext = source ? 'ts' : 'js';
const { initSourceEntries } = await import(`${moduleRoot}/lib/init-scaffold.${ext}`);

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = join(here, '../bin/somewhere.js');
const tempDir = (prefix = 'somewhere-init-admission-') => mkdtempSync(join(tmpdir(), prefix));

let requests = [];
const api = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  req.resume();
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'FIXTURE', message: 'fixture refuses' }));
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${api.address().port}`;
test.after(() => api.close());

function cli(args, cwd, { signedIn = true } = {}) {
  const configDir = tempDir('somewhere-init-admission-config-');
  if (signedIn) writeFileSync(join(configDir, 'config.json'), JSON.stringify({ token: 'smt_fixture_not_real' }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliBin, 'init', ...args], {
      cwd,
      env: { ...process.env, SOMEWHERE_CONFIG_DIR: configDir, SOMEWHERE_API_URL: apiUrl, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, out: stdout + stderr }));
  });
}

test('initSourceEntries: app surface and folders are source; notes, stray files and tool folders are not', () => {
  const dir = tempDir();
  for (const name of ['start', 'NOTES.md', 'LICENSE', '.gitignore', '.DS_Store']) writeFileSync(join(dir, name), 'x');
  mkdirSync(join(dir, '.claude'));
  mkdirSync(join(dir, '.git'));
  assert.deepEqual(initSourceEntries(dir), { source: [], other: ['.claude', '.gitignore', 'LICENSE', 'NOTES.md', 'start'] });

  writeFileSync(join(dir, 'package.json'), '{}');
  mkdirSync(join(dir, 'src'));
  assert.deepEqual(initSourceEntries(dir).source, ['package.json', 'src']);
  assert.deepEqual(initSourceEntries(tempDir()), { source: [], other: [] });
});

test('a folder holding only a stray file is refused before any request, and the file is kept', async () => {
  for (const signedIn of [true, false]) {
    requests = [];
    const dir = tempDir();
    writeFileSync(join(dir, 'start'), '1760659200\n');
    const run = await cli(['--name', 'feel-notes'], dir, { signedIn });
    assert.equal(run.status, 2, run.out);
    assert.match(run.out, /no app source[\s\S]*start[\s\S]*nothing was created/i);
    assert.match(run.out, /empty directory/);
    assert.doesNotMatch(run.out, /somewhere deploy|Project created|Existing source preserved/);
    assert.deepEqual(requests, [], `signedIn=${signedIn}`);
    assert.deepEqual(readdirSync(dir), ['start']);
    assert.equal(readFileSync(join(dir, 'start'), 'utf8'), '1760659200\n');
  }
});

test('notes and tool folders alone are not existing source either', async () => {
  requests = [];
  const dir = tempDir();
  writeFileSync(join(dir, 'NOTES.md'), 'mine\n');
  mkdirSync(join(dir, '.claude'));
  const run = await cli(['--name', 'notes-only', '--json'], dir);
  assert.equal(run.status, 2, run.out);
  assert.match(run.out, /\.claude[\s\S]*NOTES\.md/);
  assert.deepEqual(requests, []);
  assert.deepEqual(readdirSync(dir).sort(), ['.claude', 'NOTES.md']);
});

test('--bare and --link still accept a folder of other files: the caller chose to bring their own', async () => {
  for (const args of [['--name', 'bring-own', '--bare'], ['--link', '--project', 'x']]) {
    requests = [];
    const dir = tempDir();
    writeFileSync(join(dir, 'start'), 'x');
    const run = await cli(args, dir);
    assert.equal(run.status, 1, `${args.join(' ')}: the fixture API refuses: ${run.out}`);
    assert.equal(requests.length, 1, args.join(' '));
    assert.deepEqual(readdirSync(dir), ['start']);
  }
});

test('a real existing app is still linked and left untouched', async () => {
  requests = [];
  const dir = tempDir();
  writeFileSync(join(dir, 'package.json'), '{"name":"mine"}\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'main.tsx'), 'export {};\n');
  writeFileSync(join(dir, 'start'), 'x');
  const run = await cli(['--name', 'real-app'], dir);
  assert.equal(run.status, 1, `reaches project creation, which the fixture refuses: ${run.out}`);
  assert.deepEqual(requests, ['POST /projects']);
  assert.deepEqual(readdirSync(dir).sort(), ['package.json', 'src', 'start']);
});

test('an empty folder still reaches project creation; --features in a non-empty folder is refused first', async () => {
  requests = [];
  const empty = tempDir();
  const run = await cli(['--name', 'fresh'], empty);
  assert.equal(run.status, 1, run.out);
  assert.deepEqual(requests, ['POST /projects']);
  assert.deepEqual(readdirSync(empty), [], 'a failed create writes no starter');

  requests = [];
  const stray = tempDir();
  writeFileSync(join(stray, 'start'), 'x');
  const features = await cli(['--name', 'fresh', '--features', 'auth', '--json'], stray);
  assert.equal(features.status, 2, features.out);
  assert.match(features.out, /nothing was created/);
  assert.deepEqual(requests, []);
  assert.deepEqual(readdirSync(stray), ['start']);
});
