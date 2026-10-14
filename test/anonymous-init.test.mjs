import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { collectFiles } from '../dist/lib/files.js';
const cli = join(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const root = mkdtempSync(join(tmpdir(), 'anonymous-init-'));
let requests = [], refuse = false;
const project = { id: 'fixture-project', name: 'Fixture', subdomain: 'fixture', slug: 'fixture' };
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  assert.equal(req.headers.authorization, 'Bearer smt_fixture');
  res.writeHead(refuse ? 403 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(refuse ? { ok: false, error: 'FORBIDDEN', message: 'Fixture refusal' }
    : { ok: true, data: req.method === 'GET' ? { projects: [project] } : project }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
test.after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });
async function run(args, { token, prepare, explicitLink = false, explicitHook = false } = {}) {
  requests = [];
  const base = mkdtempSync(join(root, 'case-')), cwd = join(base, 'app'), config = join(base, 'config'), bin = join(base, 'bin');
  for (const dir of [cwd, config, bin]) mkdirSync(dir);
  if (token) writeFileSync(join(config, 'config.json'), JSON.stringify({ token }));
  // Only a sentinel, never npm: authenticated init's existing install call is observed locally.
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf fixture > "$PWD/install-called"\n', { mode: 0o700 });
  // Existing user-wide hook settings must remain untouched by setup.
  for (const [host, file] of [['.claude', 'settings.json'], ['.codex', 'hooks.json'], ['.cursor', 'hooks.json']]) {
    mkdirSync(join(base, host));
    writeFileSync(join(base, host, file), '{"fixture":"user-wide-kept"}');
  }
  prepare?.(cwd);
  const output = await new Promise(resolve => {
    const entry = explicitLink ? ['--input-type=module', '-e', `const { linkExisting } = await import(${JSON.stringify(new URL('../dist/commands/init.js', import.meta.url).href)}); await linkExisting({ call: async () => ({ projects: ${JSON.stringify([project])} }) }, process.cwd(), 'fixture', true);`] : explicitHook ? [cli, 'hooks', 'install', '--host', 'codex', '--json'] : [cli, 'init', ...args];
    const child = spawn(process.execPath, entry, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, HOME: base, USERPROFILE: base, SOMEWHERE_CONFIG_DIR: config,
      SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}`, PATH: `${bin}:${process.env.PATH}`,
      SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', v => stdout += v); child.stderr.on('data', v => stderr += v);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  for (const [host, file] of [['.claude', 'settings.json'], ['.codex', 'hooks.json'], ['.cursor', 'hooks.json']]) {
    assert.equal(readFileSync(join(base, host, file), 'utf8'), '{"fixture":"user-wide-kept"}');
  }
  return { ...output, cwd, config, base };
}
for (const selection of [[], ['--template', 'minimal'], ['--features', 'private-data', '--ui', 'headless']]) {
  test(`anonymous init writes valid raw starter without account, requests or install: ${selection.join(' ') || 'default'}`, async () => {
    const result = await run(['--name', 'starter', '--json', ...selection]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.local, true); assert.equal(body.linked, false); assert.equal(body.dependencies_installed, false);
    assert.equal(body.project_id, undefined); assert.ok(body.next.includes('somewhere deploy'));
    assert.deepEqual(requests, []); assert.deepEqual(readdirSync(result.config).filter(name => name !== 'last-run.json'), []);
    for (const path of ['.somewhere.json', '.mcp.json', 'node_modules', 'install-called', 'dist', 'build']) assert.equal(existsSync(join(result.cwd, path)), false, path);
    assert.equal(existsSync(join(result.base, '.claude.json')), false);
    assertInitGuidance(result, body.hooks);
    const collected = collectFiles(result.cwd);
    assert.ok(Object.keys(collected.files).every(path => !/^\.(claude|codex|cursor)\//.test(path)), 'hook configs are never deployed');
    assert.ok(collected.files['index.html']); assert.ok(Object.keys(collected.files).some(p => p.endsWith('.tsx')));
    for (const [path, content] of Object.entries(collected.files)) {
      if (!/\.tsx?$/.test(path)) continue;
      const output = ts.transpileModule(content, { fileName: path, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
      assert.deepEqual(output.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error), [], path);
    }
  });
}
test('anonymous human result directs to existing temporary deploy and full quickstart', async () => {
  const result = await run(['--name', 'starter']);
  assert.equal(result.status, 0); assert.match(result.stdout, /somewhere deploy/); assert.match(result.stdout, /somewhere docs start/);
  assert.deepEqual(requests, []);
  assertInitGuidance(result);
});
test('anonymous link/bare/project flags never bypass account authority', async () => {
  for (const args of [['--link', '--project', 'fixture'], ['--bare', '--name', 'fixture'], ['--project', 'fixture', '--name', 'fixture']]) {
    const result = await run([...args, '--json']);
    assert.notEqual(result.status, 0); assert.deepEqual(readdirSync(result.cwd), []); assert.deepEqual(requests, []);
  }
});
test('anonymous init preserves occupied, linked and malformed-link directories', async () => {
  for (const [path, content] of [['keep.txt', 'mine'], ['.somewhere.json', JSON.stringify({ project_id: 'existing', name: 'Existing' })], ['.somewhere.json', '{broken']]) {
    const result = await run(['--name', 'starter', '--json'], { prepare: dir => writeFileSync(join(dir, path), content) });
    assert.notEqual(result.status, 0); assert.deepEqual(readdirSync(result.cwd), [path]);
    assert.equal(readFileSync(join(result.cwd, path), 'utf8'), content); assert.deepEqual(requests, []);
  }
});
test('authenticated create retains remote creation, linking and install behavior', async () => {
  const result = await run(['--name', 'fixture', '--json'], { token: 'smt_fixture' });
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(JSON.parse(result.stdout).id, project.id);
  assert.deepEqual(requests, ['POST /projects']);
  assert.equal(JSON.parse(readFileSync(join(result.cwd, '.somewhere.json'))).project_id, project.id);
  assert.ok(existsSync(join(result.cwd, 'install-called'))); assert.ok(existsSync(join(result.cwd, 'index.html')));
  assertInitGuidance(result, JSON.parse(result.stdout).hooks);
});
test('authenticated link uses only owned project lookup; server denial writes nothing', async () => {
  const linked = await run(['--link', '--project', 'fixture', '--json'], { token: 'smt_fixture' });
  assert.equal(linked.status, 0, linked.stderr); assert.deepEqual(requests, ['GET /projects']);
  assert.equal(existsSync(join(linked.cwd, 'index.html')), false);
  assertNoInitHooks(linked.cwd);
  assert.equal(JSON.parse(linked.stdout).hooks, undefined);
  refuse = true;
  try {
    const rejected = await run(['--name', 'fixture', '--json'], { token: 'smt_fixture' });
    assert.notEqual(rejected.status, 0); assert.deepEqual(readdirSync(rejected.cwd), []);
    assert.deepEqual(requests, ['POST /projects']);
  } finally { refuse = false; }
});

function assertNoInitHooks(dir) {
  for (const path of ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', '.mcp.json']) {
    assert.equal(existsSync(join(dir, path)), false, path);
  }
}

function assertInitGuidance(result, hooks) {
  assertNoInitHooks(result.cwd);
  assert.equal(hooks, undefined);
  assert.ok(existsSync(join(result.cwd, 'AGENTS.md')));
  assert.equal(existsSync(join(result.cwd, '.mcp.json')), false);
  assert.equal(existsSync(join(result.base, '.claude.json')), false);
  assert.doesNotMatch(result.stdout + result.stderr, /Agent hook setup|Third-Party Imports|Claude Code MCP connected/);
}

test('authenticated text setup reports project-local hook activation', async () => {
  const result = await run(['--name', 'fixture'], { token: 'smt_fixture' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Project created/);
  assert.deepEqual(requests, ['POST /projects']);
  assertInitGuidance(result);
});

for (const json of [false, true]) {
  test(`authenticated bare setup writes no hooks (${json ? 'JSON' : 'text'})`, async () => {
    const result = await run(['--name', 'fixture', '--bare', ...(json ? ['--json'] : [])], { token: 'smt_fixture' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(requests, ['POST /projects']);
    assert.equal(existsSync(join(result.cwd, 'index.html')), false);
    assert.equal(existsSync(join(result.cwd, 'install-called')), false);
    assert.ok(existsSync(join(result.cwd, 'AGENTS.md')));
    assertInitGuidance(result, json ? JSON.parse(result.stdout).hooks : undefined);
  });
}

for (const args of [['--catalog'], ['--features', 'auth', '--name', 'fixture', '--dry-run']]) {
  test(`${args.join(' ')} does not install hooks`, async () => {
    const result = await run([...args, '--json'], { token: 'smt_fixture' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(requests, []);
    assert.deepEqual(readdirSync(result.cwd), []);
    assertNoInitHooks(result.cwd);
    assert.equal(JSON.parse(result.stdout).hooks, undefined);
  });
}

test('creating a project around existing source leaves hook setup untouched', async () => {
  const result = await run(['--name', 'fixture', '--json'], {
    token: 'smt_fixture', prepare: dir => writeFileSync(join(dir, 'keep.ts'), 'export const keep = true;'),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(result.cwd, 'keep.ts'), 'utf8'), 'export const keep = true;');
  assertNoInitHooks(result.cwd);
  assert.equal(JSON.parse(result.stdout).hooks, undefined);
});

for (const json of [false, true]) {
  test(`an occupied agent directory stays untouched during bare project creation (${json ? 'JSON' : 'text'})`, async () => {
    const result = await run(['--name', 'fixture', '--bare', ...(json ? ['--json'] : [])], {
      token: 'smt_fixture', prepare: dir => writeFileSync(join(dir, '.codex'), 'not a directory'),
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(readFileSync(join(result.cwd, '.somewhere.json'))).project_id, project.id);
    assert.ok(existsSync(join(result.cwd, 'AGENTS.md')));
    assert.equal(readFileSync(join(result.cwd, '.codex'), 'utf8'), 'not a directory');
    if (json) assert.equal(JSON.parse(result.stdout).hooks, undefined);
    assert.doesNotMatch(result.stdout + result.stderr, /Agent hook setup|Failed to create project/);
  });
}

for (const args of [['--bare'], ['--link', '--project', 'fixture'], []]) {
  test(`existing command-running agent settings survive init byte for byte: ${args.join(' ') || 'existing source'}`, async () => {
    const files = { '.claude/settings.json': '{broken', '.codex/hooks.json': '{"hooks":{"Stop":[{"command":"keep"}]}}', '.cursor/hooks.json': '{"version":1,"hooks":{}}', '.mcp.json': '{"mcpServers":{"keep":{"command":"keep"}}}' };
    const global = '{"mcpServers":{"existing":{"command":"keep-global"}}}';
    const result = await run(['--name', 'fixture', ...args, '--json'], {
      token: 'smt_fixture', prepare: dir => {
        for (const [file, content] of Object.entries(files)) {
          mkdirSync(dirname(join(dir, file)), { recursive: true });
          writeFileSync(join(dir, file), content);
        }
        writeFileSync(join(dirname(dir), '.claude.json'), global);
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const [file, content] of Object.entries(files)) assert.equal(readFileSync(join(result.cwd, file), 'utf8'), content);
    assert.equal(readFileSync(join(result.base, '.claude.json'), 'utf8'), global);
    assert.equal(JSON.parse(result.stdout).hooks, undefined);
  });
}

test('explicit standalone link keeps its command-running MCP setup', async () => {
  const result = await run([], { token: 'smt_fixture', explicitLink: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const file of [join(result.cwd, '.mcp.json'), join(result.base, '.claude.json')]) {
    const entry = JSON.parse(readFileSync(file, 'utf8')).mcpServers.somewhere;
    assert.equal(entry.command, 'somewhere');
    assert.deepEqual(entry.args, ['mcp']);
  }
  assert.equal(JSON.parse(readFileSync(join(result.cwd, '.somewhere.json'))).project_id, project.id);
});

test('init existing-project linking in human output installs no agent config', async () => {
  const result = await run(['--link', '--project', 'fixture'], { token: 'smt_fixture' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertNoInitHooks(result.cwd);
  assert.equal(existsSync(join(result.base, '.claude.json')), false);
  assert.deepEqual(requests, ['GET /projects']);
});

test('explicit opt-in installs only the selected host typecheck hook, without MCP or global setup', async () => {
  const result = await run([], { explicitHook: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readdirSync(result.cwd), ['.codex']);
  const hooks = JSON.parse(readFileSync(join(result.cwd, '.codex/hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks), ['PostToolUse']);
  assert.equal(hooks.PostToolUse.length, 1);
  assert.equal(hooks.PostToolUse[0].matcher, 'Edit|Write');
  assert.equal(hooks.PostToolUse[0].hooks.length, 1);
  assert.match(hooks.PostToolUse[0].hooks[0].command, /somewhere typecheck --deploy --hook codex$/);
  assert.equal(existsSync(join(result.cwd, '.mcp.json')), false);
  assert.equal(existsSync(join(result.base, '.claude.json')), false);
});
