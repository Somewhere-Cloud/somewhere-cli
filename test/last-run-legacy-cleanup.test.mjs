import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsk_d8eac29404da: a run record an older CLI filled with argument values and
// output is removed at startup, before any command runs (help, version and
// usage errors included). Login and session files stay; nothing is read,
// printed or copied; a symlinked record is removed without touching its target.
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const SENTINEL = 'legacy7-plainvalue-WQ19';
const legacyRecord = JSON.stringify({ command: 'env', args: ['set', 'DB_PASSWORD', SENTINEL], exit_code: 0, stdout_tail: `UPDATE users SET pw='${SENTINEL}'`, stderr_tail: '', timestamp: '2026-10-01T00:00:00.000Z' });
const login = JSON.stringify({ token: 'smt_fixture_login', user: { email: 'dev@example.test', username: 'dev' } });
const session = JSON.stringify({ token: 'smt_fixture_temp', temp_expires_at: '2099-01-01T00:00:00.000Z' });

let release;
const server = createServer((req, res) => {
  if (req.url === '/') return res.end(); // this machine's local-port poller
  const reply = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: { done: true } })); };
  if (req.url.startsWith('/v1/slow')) { release = reply; return; }
  reply();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());

function seed(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'last-run.json'), legacyRecord, { mode: 0o600 });
  writeFileSync(join(dir, 'last-run.json.tmp'), legacyRecord, { mode: 0o600 });
  writeFileSync(join(dir, 'config.json'), login, { mode: 0o600 });
  writeFileSync(join(dir, 'temp-session.json'), session, { mode: 0o600 });
}
function start(args, { configDir, home }) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
    SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1' };
  if (configDir) env.SOMEWHERE_CONFIG_DIR = configDir; else delete env.SOMEWHERE_CONFIG_DIR;
  const child = spawn(process.execPath, [cli, ...args], { cwd: home, stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  child.stdout.on('data', (v) => { out += v; }); child.stderr.on('data', (v) => { out += v; });
  return { child, done: new Promise((resolve) => child.on('close', (status) => resolve({ status, out: () => out }))) };
}
function assertCleaned(dir, out) {
  assert.doesNotMatch(out, new RegExp(SENTINEL), 'contents are never printed');
  for (const name of readdirSync(dir)) {
    if (lstatSync(join(dir, name)).isFile()) assert.doesNotMatch(readFileSync(join(dir, name), 'utf8'), new RegExp(SENTINEL), name);
  }
  assert.equal(existsSync(join(dir, 'last-run.json.tmp')), false);
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), login, 'login kept');
  assert.equal(readFileSync(join(dir, 'temp-session.json'), 'utf8'), session, 'session kept');
  if (existsSync(join(dir, 'last-run.json'))) {
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'))).sort(), ['cli_version', 'command', 'exit_code', 'options', 'timestamp']);
  }
}

for (const args of [['--help'], ['--version'], ['no-such-command', 'x'], ['deploy', '--no-such-flag'], ['docs', '--section']]) {
  test(`custom config dir: \`${args.join(' ')}\` removes the legacy record; login and session stay`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'sw-legacy-'));
    const configDir = join(home, 'custom-config');
    seed(configDir);
    const result = await start(args, { configDir, home }).done;
    assertCleaned(configDir, result.out());
  });
}

test('default config dir (~/.somewhere) is cleaned too', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-legacy-home-'));
  seed(join(home, '.somewhere'));
  const result = await start(['--version'], { home }).done;
  assertCleaned(join(home, '.somewhere'), result.out());
});

test('a long-running command: the legacy record is gone while it is still running', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-legacy-long-'));
  const configDir = join(home, 'cfg');
  seed(configDir);
  release = null;
  const run = start(['api', 'GET', '/slow'], { configDir, home });
  const until = Date.now() + 10_000;
  while (!release) { if (Date.now() > until) throw new Error('request never arrived'); await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(run.child.exitCode, null, 'still running');
  assert.equal(existsSync(join(configDir, 'last-run.json')), false, 'removed before the command finished');
  assert.equal(existsSync(join(configDir, 'last-run.json.tmp')), false);
  release();
  const result = await run.done;
  assert.equal(result.status, 0, result.out());
  assertCleaned(configDir, result.out());
});

test('a symlinked record is removed without following it; its target is untouched', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-legacy-link-'));
  const configDir = join(home, 'cfg');
  seed(configDir);
  const target = join(home, 'elsewhere.txt');
  writeFileSync(target, `keep ${SENTINEL}`);
  const link = join(configDir, 'last-run.json');
  rmSync(link);
  symlinkSync(target, link);
  const result = await start(['--version'], { configDir, home }).done;
  assert.equal(readFileSync(target, 'utf8'), `keep ${SENTINEL}`, 'the link target is never written or removed');
  assert.ok(!lstatSync(link).isSymbolicLink(), 'the link itself was replaced by the metadata record');
  assert.doesNotMatch(result.out(), new RegExp(SENTINEL));
});

test('a record that cannot be removed is reported by path and error code, never its contents', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-legacy-ro-'));
  const configDir = join(home, 'cfg');
  seed(configDir);
  chmodSync(configDir, 0o500); // the directory refuses unlink
  try {
    const result = await start(['--version'], { configDir, home }).done;
    assert.match(result.out(), new RegExp(`Could not remove ${join(configDir, 'last-run.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(EACCES\\)`));
    assert.doesNotMatch(result.out(), new RegExp(SENTINEL));
  } finally { chmodSync(configDir, 0o700); }
});

test('a directory named last-run.json is left alone and reported', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sw-legacy-dir-'));
  const configDir = join(home, 'cfg');
  mkdirSync(join(configDir, 'last-run.json'), { recursive: true });
  writeFileSync(join(configDir, 'last-run.json', 'keep.txt'), 'keep');
  const result = await start(['--version'], { configDir, home }).done;
  assert.match(result.out(), /is a directory, not this CLI's run record/);
  assert.equal(readFileSync(join(configDir, 'last-run.json', 'keep.txt'), 'utf8'), 'keep');
});
