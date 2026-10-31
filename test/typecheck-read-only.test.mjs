import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScaffoldTsconfig } from '../dist/lib/scaffold.js';

// `somewhere typecheck` is read-only (pfb_8f0f7cdd04a1): it never installs into
// the project, refuses when declared type packages are missing, and every
// child it starts is bounded and stopped with its own children.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

function project(files) {
  const base = mkdtempSync(join(tmpdir(), 'sw-tc-ro-'));
  const dir = join(base, 'app'), bin = join(base, 'bin');
  mkdirSync(dir); mkdirSync(bin);
  // Any npm call is recorded: the typecheck must never make one.
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${join(base, 'npm-called')}"\n`, { mode: 0o755 });
  for (const [path, content] of Object.entries({ 'tsconfig.json': buildScaffoldTsconfig(), ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return { base, dir, bin };
}
function start(args, { base, dir, bin }, env = {}) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, SOMEWHERE_CONFIG_DIR: join(base, 'config'),
    SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1', ...env,
  } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (v) => stdout += v); child.stderr.on('data', (v) => stderr += v);
  const done = new Promise((resolve) => child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr, out: stdout + stderr })));
  return { child, done };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(path, ms = 10_000) {
  const until = Date.now() + ms;
  while (!existsSync(path) || !readFileSync(path, 'utf8').trim()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return Number(readFileSync(path, 'utf8').trim());
}

test('declared type packages that are not installed: refused, nothing installed, project files untouched', async () => {
  const manifest = JSON.stringify({ name: 'fixture', devDependencies: { '@types/react': '^19.0.0' } });
  const p = project({ 'package.json': manifest, 'index.ts': 'export const x = 1;\n' });
  const text = await start(['typecheck'], p).done;
  assert.equal(text.status, 1, text.out);
  assert.match(text.out, /Not checked: this project's declared type packages are not installed \(@types\/react\)/);
  assert.match(text.out, /does not install packages/);
  const json = await start(['typecheck', '--json'], p).done;
  assert.equal(json.status, 1);
  const body = JSON.parse(json.stdout);
  assert.equal(body.ok, false);
  assert.match(body.spawnError, /npm install in /);
  assert.equal(existsSync(join(p.dir, 'node_modules')), false);
  assert.equal(existsSync(join(p.base, 'npm-called')), false);
  assert.equal(readFileSync(join(p.dir, 'package.json'), 'utf8'), manifest);
});

test('installed declared types: the check runs and passes', async () => {
  const p = project({
    'package.json': JSON.stringify({ devDependencies: { '@types/fixture-globals': '^1.0.0' } }),
    'node_modules/@types/fixture-globals/index.d.ts': 'declare type FixtureSeatCount = number;\n',
    'node_modules/@types/fixture-globals/package.json': JSON.stringify({ name: '@types/fixture-globals', version: '1.0.0', types: 'index.d.ts' }),
    'index.ts': 'export const seats: FixtureSeatCount = 4;\n',
  });
  const result = await start(['typecheck'], p).done;
  assert.equal(result.status, 0, result.out);
  assert.equal(existsSync(join(p.base, 'npm-called')), false);
});

// A project compiler that hangs and has its own child, like npx fetching TypeScript.
function hangingProject() {
  const p = project({ 'index.ts': 'export const x = 1;\n' });
  const tsc = join(p.dir, 'node_modules/.bin/tsc');
  mkdirSync(dirname(tsc), { recursive: true });
  writeFileSync(tsc, `#!/bin/sh\nsleep 120 &\necho $! > "${join(p.base, 'grandchild.pid')}"\nwait\n`);
  chmodSync(tsc, 0o755);
  return p;
}

test('a typecheck that does not finish is stopped at the deadline, with its children', { skip: process.platform === 'win32' }, async () => {
  const p = hangingProject();
  const run = start(['typecheck', '--json'], p, { SOMEWHERE_TYPECHECK_TIMEOUT_MS: '1500' });
  const grandchild = await waitFor(join(p.base, 'grandchild.pid'));
  const result = await run.done;
  assert.equal(result.status, 1, result.out);
  assert.match(JSON.parse(result.stdout).spawnError, /did not finish within 2s and was stopped/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(grandchild), false, 'the compiler\'s own child must not outlive the command');
});

test('Ctrl-C stops the typecheck and its children', { skip: process.platform === 'win32' }, async () => {
  const p = hangingProject();
  const run = start(['typecheck'], p);
  const grandchild = await waitFor(join(p.base, 'grandchild.pid'));
  run.child.kill('SIGINT');
  const result = await run.done;
  assert.equal(result.status, 130, result.out);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(grandchild), false, 'no orphan after Ctrl-C');
});
