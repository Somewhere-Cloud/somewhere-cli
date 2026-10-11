import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hooksModule = process.env.SOMEWHERE_TEST_SOURCE ? '../src/lib/agent-hooks.ts' : '../dist/lib/agent-hooks.js';
const {
  affectsDeployCheck, agentHookCommand, editedPaths, formatAgentHookInstall, hookProjectRoot, installAgentHooks, pathCliIsThisCli, runAgentHook,
} = await import(hooksModule);

function project(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-agent-hooks-'));
  for (const [path, text] of Object.entries({ 'package.json': JSON.stringify({ name: 'fixture', private: true }), ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const read = (dir, path) => JSON.parse(readFileSync(join(dir, path), 'utf8'));
const CMD = (host) => `somewhere typecheck --deploy --hook ${host}`;

// ── installed command ─────────────────────────────────────────────────────

test('the hook runs `somewhere` only when PATH holds this same CLI, else this exact version from the npm cache', () => {
  assert.equal(agentHookCommand('claude-code', { usePathCli: true }), 'somewhere typecheck --deploy --hook claude-code');
  assert.equal(agentHookCommand('codex', { usePathCli: false, version: '0.37.27' }),
    'npx --yes --prefer-offline --package=@somewhere-tech/cli@0.37.27 somewhere typecheck --deploy --hook codex');
  const bin = fileURLToPath(new URL('../bin/somewhere.js', import.meta.url));
  const pathDir = mkdtempSync(join(tmpdir(), 'sw-path-'));
  symlinkSync(bin, join(pathDir, 'somewhere'));
  assert.equal(pathCliIsThisCli(pathDir, bin), true, 'a PATH link to this CLI counts');
  const other = mkdtempSync(join(tmpdir(), 'sw-path-other-'));
  writeFileSync(join(other, 'somewhere'), '#!/bin/sh\n');
  assert.equal(pathCliIsThisCli(other, bin), false, 'another installed version does not');
  assert.equal(pathCliIsThisCli('', bin), false, 'nothing on PATH (setup ran through npx)');
});

// ── installation ──────────────────────────────────────────────────────────

test('claude-code: adds one PostToolUse check to new project settings', () => {
  const dir = project();
  const [result] = installAgentHooks({ projectDir: dir, hosts: ['claude-code'], command: CMD });
  assert.equal(result.status, 'added');
  assert.deepEqual(read(dir, '.claude/settings.json'), {
    hooks: { PostToolUse: [{ matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: [{ type: 'command', command: CMD('claude-code'), timeout: 300 }] }] },
  });
});

test('claude-code: merges into existing settings and hooks without replacing them, and is idempotent', () => {
  const existing = {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
    },
  };
  const dir = project({ '.claude/settings.json': JSON.stringify(existing) });
  installAgentHooks({ projectDir: dir, hosts: ['claude-code'], command: CMD });
  const merged = read(dir, '.claude/settings.json');
  assert.deepEqual(merged.permissions, existing.permissions);
  assert.deepEqual(merged.hooks.PreToolUse, existing.hooks.PreToolUse);
  assert.deepEqual(merged.hooks.PostToolUse[0], existing.hooks.PostToolUse[0]);
  assert.equal(merged.hooks.PostToolUse.length, 2);
  const before = readFileSync(join(dir, '.claude/settings.json'), 'utf8');
  assert.equal(installAgentHooks({ projectDir: dir, hosts: ['claude-code'], command: CMD })[0].status, 'unchanged');
  assert.equal(readFileSync(join(dir, '.claude/settings.json'), 'utf8'), before);
});

test('an installed check with another command (e.g. a new CLI version) is updated in place', () => {
  const dir = project();
  installAgentHooks({ projectDir: dir, hosts: ['claude-code'], command: () => 'npx --yes --prefer-offline --package=@somewhere-tech/cli@0.37.26 somewhere typecheck --deploy --hook claude-code' });
  const [result] = installAgentHooks({ projectDir: dir, hosts: ['claude-code'], command: CMD });
  assert.equal(result.status, 'updated');
  const entries = read(dir, '.claude/settings.json').hooks.PostToolUse;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hooks[0].command, CMD('claude-code'));
});

test('unreadable host settings are refused and left byte-for-byte unchanged', () => {
  const dir = project({ '.claude/settings.json': '{ "hooks": ' });
  const [result] = installAgentHooks({ projectDir: dir, hosts: ['claude-code'], command: CMD });
  assert.equal(result.status, 'refused');
  assert.equal(readFileSync(join(dir, '.claude/settings.json'), 'utf8'), '{ "hooks": ');
  assert.match(formatAgentHookInstall([result], dir)[0], /not installed/);
});

test('never installs into the home directory (user-wide settings)', () => {
  assert.throws(() => installAgentHooks({ projectDir: homedir(), hosts: ['claude-code'], command: CMD }), /home directory/);
});

test('codex: PostToolUse with the apply_patch matcher in .codex/hooks.json, and its review step is reported', () => {
  const dir = project({ '.codex/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } }) });
  const [result] = installAgentHooks({ projectDir: dir, hosts: ['codex'], command: CMD });
  assert.deepEqual(read(dir, '.codex/hooks.json'), {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }],
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: CMD('codex'), timeout: 300 }] }],
    },
  });
  assert.match(result.activation, /\/hooks/);
});

test('cursor: postToolUse definition in .cursor/hooks.json with version 1, keeping existing hooks', () => {
  const dir = project({ '.cursor/hooks.json': JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: 'fmt.sh' }] } }) });
  const [result] = installAgentHooks({ projectDir: dir, hosts: ['cursor'], command: CMD });
  assert.deepEqual(read(dir, '.cursor/hooks.json'), {
    version: 1,
    hooks: { afterFileEdit: [{ command: 'fmt.sh' }], postToolUse: [{ command: CMD('cursor'), matcher: 'Write', timeout: 300 }] },
  });
  assert.match(result.activation, /trusted workspace/);
});

// ── which edits trigger a check ───────────────────────────────────────────

test('source, schema, tsconfig, manifest and lockfile edits trigger a check; other files do not', () => {
  for (const path of ['src/App.tsx', 'api/hello.ts', 'src/legacy.jsx', 'lib/x.mjs', 'db/schema.ts', 'tsconfig.json', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock']) {
    assert.equal(affectsDeployCheck(path), true, path);
  }
  for (const path of ['README.md', 'src/styles.css', 'index.html', 'public/logo.svg', 'node_modules/x/index.js', '.claude/settings.json', 'packages/a/package.json', '../outside.ts']) {
    assert.equal(affectsDeployCheck(path), false, path);
  }
});

test('edited paths come from each host event; an event without them yields null (check anyway)', () => {
  assert.deepEqual(editedPaths('claude-code', { tool_input: { file_path: '/p/src/a.ts' } }), ['/p/src/a.ts']);
  assert.deepEqual(editedPaths('claude-code', { tool_input: { notebook_path: '/p/n.ipynb' } }), ['/p/n.ipynb']);
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n*** End Patch';
  assert.deepEqual(editedPaths('codex', { tool_input: { command: patch } }), ['src/a.ts', 'src/b.ts', 'src/old.ts', 'src/new.ts']);
  assert.equal(editedPaths('cursor', { tool_name: 'Write', tool_input: {} }), null);
  assert.equal(editedPaths('codex', { tool_input: { command: 'not a patch' } }), null);
});

test('the checked project is the one whose host settings install the check, never a guess', () => {
  const dir = project();
  installAgentHooks({ projectDir: dir, hosts: ['claude-code'], command: CMD });
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  assert.equal(hookProjectRoot('claude-code', { cwd: join(dir, 'src', 'deep') }, {}), dir);
  assert.equal(hookProjectRoot('claude-code', {}, { CLAUDE_PROJECT_DIR: dir }), dir);
  assert.equal(hookProjectRoot('codex', { cwd: dir }, {}), null, 'codex is not installed there');
});

// ── output envelopes ──────────────────────────────────────────────────────

const FINDINGS = { ok: false, typescript: '5.6.3', checkedFiles: 2, findings: [
  { kind: 'reference', code: 'TS2304', file: 'src/a.ts', line: 3, column: 7, message: "Cannot find name 'App'." },
] };
const CLEAN = { ok: true, typescript: '5.6.3', checkedFiles: 2, findings: [] };
const BROKEN = { ok: false, typescript: '5.6.3', checkedFiles: 0, findings: [], error: "error TS2688: Cannot find type definition file for 'x'." };

async function hookRun(host, result, payloadFor) {
  const dir = project();
  installAgentHooks({ projectDir: dir, hosts: [host], command: CMD });
  let checked = 0;
  const outcome = await runAgentHook(host, JSON.stringify(payloadFor(dir)), {
    check: async () => { checked++; return result; }, env: {}, cwd: dir,
  });
  return { ...outcome, checked };
}
const claudeEdit = (dir) => ({ hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'src/a.ts') } });
const codexEdit = (dir) => ({ hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' } });
const cursorEdit = (dir) => ({ hook_event_name: 'postToolUse', cwd: dir, tool_name: 'Write', tool_input: {} });

test('claude-code envelopes: findings exit 2 on stderr; could-not-run is additionalContext; clean is silent', async () => {
  const found = await hookRun('claude-code', FINDINGS, claudeEdit);
  assert.equal(found.exitCode, 2);
  assert.equal(found.stdout, '');
  assert.match(found.stderr, /1 finding a deploy would report[\s\S]*src\/a\.ts:3:7 TS2304 Cannot find name 'App'\./);
  const broken = await hookRun('claude-code', BROKEN, claudeEdit);
  assert.equal(broken.exitCode, 0);
  const context = JSON.parse(broken.stdout).hookSpecificOutput;
  assert.equal(context.hookEventName, 'PostToolUse');
  assert.match(context.additionalContext, /could not run[\s\S]*TS2688/);
  assert.deepEqual(await hookRun('claude-code', CLEAN, claudeEdit), { exitCode: 0, stdout: '', stderr: '', checked: 1 });
});

test('codex envelopes: findings exit 2 on stderr; could-not-run is hookSpecificOutput.additionalContext; clean is silent', async () => {
  const found = await hookRun('codex', FINDINGS, codexEdit);
  assert.equal(found.exitCode, 2);
  assert.match(found.stderr, /TS2304/);
  const broken = await hookRun('codex', BROKEN, codexEdit);
  assert.equal(broken.exitCode, 0);
  assert.match(JSON.parse(broken.stdout).hookSpecificOutput.additionalContext, /could not run/);
  assert.deepEqual(await hookRun('codex', CLEAN, codexEdit), { exitCode: 0, stdout: '', stderr: '', checked: 1 });
});

test('cursor envelopes: findings and could-not-run are additional_context (exit 0); clean is silent; unknown paths still check', async () => {
  const found = await hookRun('cursor', FINDINGS, cursorEdit);
  assert.equal(found.exitCode, 0);
  assert.equal(found.checked, 1, 'the event carried no path, so the check ran anyway');
  assert.match(JSON.parse(found.stdout).additional_context, /TS2304/);
  const broken = await hookRun('cursor', BROKEN, cursorEdit);
  assert.match(JSON.parse(broken.stdout).additional_context, /could not run/);
  assert.deepEqual(await hookRun('cursor', CLEAN, cursorEdit), { exitCode: 0, stdout: '', stderr: '', checked: 1 });
});

test('edits that cannot change findings, or outside the project, run no check', async () => {
  const docs = await hookRun('claude-code', FINDINGS, (dir) => ({ cwd: dir, tool_input: { file_path: join(dir, 'README.md') } }));
  assert.deepEqual(docs, { exitCode: 0, stdout: '', stderr: '', checked: 0 });
  const outside = await hookRun('claude-code', FINDINGS, (dir) => ({ cwd: dir, tool_input: { file_path: join(dirname(dir), 'elsewhere.ts') } }));
  assert.equal(outside.checked, 0);
  const lockfile = await hookRun('claude-code', CLEAN, (dir) => ({ cwd: dir, tool_input: { file_path: join(dir, 'package-lock.json') } }));
  assert.equal(lockfile.checked, 1);
});

test('a hook outside any project with the check installed says so instead of looking clean', async () => {
  const dir = project();
  const outcome = await runAgentHook('claude-code', JSON.stringify(claudeEdit(dir)), { check: async () => CLEAN, env: {}, cwd: dir });
  assert.match(JSON.parse(outcome.stdout).hookSpecificOutput.additionalContext, /could not run/);
});

// ── the real command, end to end ──────────────────────────────────────────

test('end to end: the installed Claude Code command reports a real finding, then goes quiet once fixed', { timeout: 120_000 }, () => {
  const bin = fileURLToPath(new URL('../bin/somewhere.js', import.meta.url));
  const dir = project({ 'src/a.ts': 'export const a = documnt.title;\n' });
  const install = spawnSync(process.execPath, [bin, 'hooks', 'install', dir, '--json'], { encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const installed = read(dir, '.claude/settings.json').hooks.PostToolUse[0].hooks[0].command;
  assert.match(installed, /typecheck --deploy --hook claude-code$/);
  // The test runs bin/somewhere.js directly, so PATH's `somewhere` (if any) is not this CLI: pinned npx form.
  assert.match(installed, /^npx --yes --prefer-offline --package=@somewhere-tech\/cli@\d+\.\d+\.\d+ somewhere typecheck/);
  const event = JSON.stringify({ hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'src/a.ts') } });
  const run = () => spawnSync(process.execPath, [bin, 'typecheck', '--deploy', '--hook', 'claude-code'], { input: event, encoding: 'utf8', cwd: dir, env: { ...process.env, NO_COLOR: '1' } });
  const failing = run();
  assert.equal(failing.status, 2);
  assert.match(failing.stderr, /src\/a\.ts:1:18 TS2552 Cannot find name 'documnt'/);
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = document.title;\n');
  const clean = run();
  assert.deepEqual([clean.status, clean.stdout, clean.stderr], [0, '', '']);
  assert.equal(existsSync(join(dir, '.codex')), false, 'only the requested host was configured');
});
