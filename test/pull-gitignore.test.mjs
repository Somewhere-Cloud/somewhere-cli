import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScaffoldGitignore } from '../dist/lib/scaffold.js';
import { createHappyPathTemplate } from '../dist/lib/init-template.js';
import { createGreenTemplate } from '../dist/lib/init-green-template.js';
import { createFeatureTemplate } from '../dist/lib/init-feature-template.js';

// tsk_8a68dfa2 item 8: deploys skip dotfiles, so a pulled app has no
// .gitignore and `somewhere typecheck` left src/__somewhere_data.d.ts
// (~3100 lines) untracked. pull writes the starters' .gitignore when the
// folder has none, and never touches one that exists.
const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && url.pathname.endsWith('/deploy/source')) {
    res.end(JSON.stringify({ ok: true, data: {
      project_id: 'proj_pull', env: 'prod', version: 3,
      static_files: { 'index.html': '<p>hi</p>\n', 'src/main.tsx': 'export {};\n' },
      binary_files: {}, functions: {},
      counts: { static_files: 2, binary_files: 0, functions: 0 },
    } }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND', message: req.url }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function pull(args, cwd, configDir) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, 'pull', 'proj_pull', ...args], {
      cwd, env: { ...process.env, NO_COLOR: '1', SOMEWHERE_API_URL: apiUrl, SOMEWHERE_CONFIG_DIR: configDir },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (status) => resolvePromise({ status, out }));
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sw-pull-gitignore-'));
  const configDir = join(root, 'config');
  const app = join(root, 'app');
  mkdirSync(configDir);
  mkdirSync(app);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ token: 'smt_account', user: { email: 'd@e.f', username: 'd' } }));
  return { app, configDir };
}

test('the pulled .gitignore is the same text every init starter ships', () => {
  for (const files of [createHappyPathTemplate(), createGreenTemplate(), createFeatureTemplate({ requested: ['auth'], added: [], modules: ['auth'], ui: 'styled' }, { appName: 'x' })]) {
    const starter = files.find((f) => f.path === '.gitignore');
    assert.ok(starter, 'starter ships a .gitignore');
    assert.equal(buildScaffoldGitignore(), starter.content);
  }
});

test('pull into a folder with no .gitignore writes one that ignores the generated declarations', async () => {
  const { app, configDir } = fixture();
  const r = await pull([], app, configDir);
  assert.equal(r.status, 0, r.out);
  assert.equal(readFileSync(join(app, '.gitignore'), 'utf8'), buildScaffoldGitignore());
  assert.match(r.out, /\.gitignore/);
  // Real git, not a string match: the declarations typecheck writes under src/ are ignored,
  // and the app's own source is not.
  if (spawnSync('git', ['--version']).status === 0) {
    spawnSync('git', ['init', '-q'], { cwd: app });
    assert.equal(spawnSync('git', ['check-ignore', '-q', 'src/__somewhere_data.d.ts'], { cwd: app }).status, 0);
    assert.equal(spawnSync('git', ['check-ignore', '-q', 'src/__somewhere_files.d.ts'], { cwd: app }).status, 0);
    assert.equal(spawnSync('git', ['check-ignore', '-q', 'src/main.tsx'], { cwd: app }).status, 1);
    assert.equal(spawnSync('git', ['check-ignore', '-q', 'db/schema.ts'], { cwd: app }).status, 1);
  }
});

test('an existing .gitignore is left byte-identical, even with --force', async () => {
  for (const args of [[], ['--force']]) {
    const { app, configDir } = fixture();
    const mine = '# mine\n*.log\n';
    writeFileSync(join(app, '.gitignore'), mine);
    const r = await pull(args, app, configDir);
    assert.equal(r.status, 0, r.out);
    assert.equal(readFileSync(join(app, '.gitignore'), 'utf8'), mine, args.join(' '));
    assert.doesNotMatch(r.out, /Added[^\n]*\.gitignore/, args.join(' '));
  }
});

test('pull --json also writes it when absent (same scaffold path)', async () => {
  const { app, configDir } = fixture();
  const r = await pull(['--json'], app, configDir);
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(join(app, '.gitignore')));
});
