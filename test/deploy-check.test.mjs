import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const deployCheckModule = process.env.SOMEWHERE_TEST_SOURCE
  ? '../src/lib/deploy-check.ts'
  : '../dist/lib/deploy-check.js';
const { DEPLOY_CHECK_TYPESCRIPT_VERSION, deployCheckTsc, parseDeployOutput, projectCompilerOptions, runDeployCheck } = await import(deployCheckModule);

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-deploy-check-'));
  for (const [path, text] of Object.entries({ 'package.json': JSON.stringify({ name: 'fixture', private: true }), ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const SCHEMA = `import { id, owner, schema, table, text } from 'somewhere/db';
export default schema({
  notes: table({ id: id(), title: text() }, { scope: owner(), client: { read: ['id', 'title'], identity: 'authenticated' } }),
});
`;

test('runs the deploy TypeScript, never another version', () => {
  assert.equal(DEPLOY_CHECK_TYPESCRIPT_VERSION, '5.6.3');
  const invocation = deployCheckTsc(project({}), 'linux');
  assert.deepEqual(invocation, { command: 'npx', args: ['-y', '-p', 'typescript@5.6.3', 'tsc'] });
  const other = project({ 'node_modules/typescript/package.json': JSON.stringify({ version: '5.9.3' }) });
  assert.equal(deployCheckTsc(other, 'linux').command, 'npx');
});

test('reads tsconfig compilerOptions as the deploy does', () => {
  assert.deepEqual(projectCompilerOptions('{\n // note\n "compilerOptions": { "strict": true, /* x */ "paths": { "@/*": ["src/*"] }, },\n}'),
    { strict: true, paths: { '@/*': ['src/*'] } });
  assert.deepEqual(projectCompilerOptions('{ "compilerOptions": { "outDir": "a//b" } }'), { outDir: 'a//b' });
  assert.deepEqual(projectCompilerOptions('{ not json'), {});
  assert.deepEqual(projectCompilerOptions(undefined), {});
});

test('fires: undefined names and type-shape mistakes, with source locations', async () => {
  const dir = project({
    'src/main.tsx': "import { createRoot } from 'react-dom/client';\ncreateRoot(document.body).render(<App />);\n",
    'src/speech.jsx': 'export function speak(t) {\n  return sanitizeForSpeech(t);\n}\n',
    'api/user.ts': 'interface U { name: string }\nexport default async function (req: Request, sw: any) {\n  const u: U = { name: "a" };\n  return Response.json({ n: u.nmae });\n}\n',
  });
  const result = await runDeployCheck(dir);
  assert.equal(result.error, undefined);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map((f) => `${f.kind}:${f.code}@${f.file}:${f.line}`).sort(), [
    'reference:TS2304@src/main.tsx:2',
    'reference:TS2304@src/speech.jsx:2',
    'type:TS2339@api/user.ts:4',
  ]);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('.__somewhere')), [], 'the temporary config is removed');
});

test('passes: handlers, sw.endpoint, managed data, browser globals, untyped libraries and env', async () => {
  const dir = project({
    'db/schema.ts': SCHEMA,
    'src/main.tsx': "import { notes } from 'somewhere:data';\nimport thing from 'some-untyped-lib';\nexport const run = async () => [await notes.list(), thing(1), localStorage.getItem('k'), await fetch('/api/x')];\n",
    'api/hello.ts': "export default async function (req: Request, sw: any) {\n  const r = await sw.db.query('SELECT 1', []);\n  return Response.json({ rows: r.data, key: sw.env.STRIPE_KEY });\n}\n",
    'api/typed.ts': "export default sw.endpoint({ auth: 'none', handler: async () => Response.json({ ok: true }) });\n",
  });
  const result = await runDeployCheck(dir);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

const findings = (result) => result.findings.map((f) => `${f.kind}:${f.code}@${f.file}:${f.line}`).sort();
const HELPER = { 'src/lib/h.ts': 'export function helper(a: number) { return a; }\n', 'src/main.ts': "import { helper } from '@/lib/h';\nexport const v = helper(1, 2);\n" };

test('paths without baseUrl resolve from the project root, through a commented tsconfig', async () => {
  const result = await runDeployCheck(project({
    ...HELPER,
    'tsconfig.json': '{\n  // aliases\n  "compilerOptions": {\n    "paths": { "@/*": ["src/*"] }, /* no baseUrl */\n  },\n}\n',
  }));
  assert.equal(result.error, undefined);
  assert.deepEqual(findings(result), ['type:TS2554@src/main.ts:2'], 'the alias resolved, so the arity mistake is found');
});

test('an explicit baseUrl keeps its own root for paths', async () => {
  const result = await runDeployCheck(project({
    ...HELPER,
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src', paths: { '@/*': ['*'] } } }),
  }));
  assert.deepEqual(findings(result), ['type:TS2554@src/main.ts:2']);
});

const APP_GLOBALS = {
  'node_modules/@types/appglobals/package.json': JSON.stringify({ name: '@types/appglobals', version: '1.0.0', types: 'index.d.ts' }),
  'node_modules/@types/appglobals/index.d.ts': 'declare const APP_VERSION: string;\n',
  'src/main.ts': 'export const version = APP_VERSION;\n',
};

test("installed @types are not discovered automatically, as on deploy", async () => {
  const result = await runDeployCheck(project(APP_GLOBALS));
  assert.deepEqual(findings(result), ['reference:TS2304@src/main.ts:1']);
});

test('a tsconfig that names its types keeps them, as on deploy', async () => {
  const result = await runDeployCheck(project({ ...APP_GLOBALS, 'tsconfig.json': JSON.stringify({ compilerOptions: { types: ['appglobals'] } }) }));
  assert.deepEqual(findings(result), []);
});

test('sw.endpoint is defined only in function modules; other bare sw stays reported', async () => {
  const dir = project({
    // A stale editor declaration that declares `sw` globally must not hide anything:
    // it is not part of what a deploy uploads or checks.
    'src/__somewhere_data.d.ts': '// Generated by Somewhere from db/schema.ts. Do not edit.\ndeclare const sw: any;\n',
    'api/typed.ts': "export default sw\n  .endpoint({ auth: 'none', handler: async () => Response.json({ ok: true }) });\n",
    'api/bare.ts': 'const db = sw.db;\nexport default async function () { return Response.json({ db: !!db }); }\n',
    'src/main.ts': "export const e = sw.endpoint;\n",
  });
  const result = await runDeployCheck(dir);
  assert.deepEqual(findings(result), ['reference:TS2304@api/bare.ts:1', 'reference:TS2304@src/main.ts:1']);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('.__somewhere')), [], 'temporary config and declarations are removed');
});

test('a config or global error beside located findings means the check did not run', () => {
  const dir = project({ 'src/a.ts': 'export const a = documnt;\n' });
  const parsed = parseDeployOutput([
    "src/a.ts(1,18): error TS2552: Cannot find name 'documnt'. Did you mean 'document'?",
    ".__somewhere_deploy_check_x.json(1,44): error TS5023: Unknown compiler option 'bogusOption'.",
    "error TS2688: Cannot find type definition file for 'missingpkg'.",
    '  The file is in the program because:',
    "error TS6053: File 'gone.ts' not found.",
  ].join('\n'), dir, {});
  assert.deepEqual(parsed.findings.map((f) => f.code), ['TS2552']);
  assert.deepEqual(parsed.problems, [
    ".__somewhere_deploy_check_x.json(1,44): error TS5023: Unknown compiler option 'bogusOption'.",
    "error TS2688: Cannot find type definition file for 'missingpkg'.",
  ], 'ignored codes stay ignored; config and global errors are problems');
});

test('a missing type library is reported as a failed check, never as a verdict', async () => {
  const result = await runDeployCheck(project({
    'src/a.ts': 'export const a = documnt;\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: ['missingpkg'] } }),
  }));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /TS2688/);
});

test('a project that cannot be read returns a failed check instead of throwing', async () => {
  const dir = project({ 'src/a.ts': 'export const a = 1;\n' });
  mkdirSync(join(dir, 'tsconfig.json'));
  const result = await runDeployCheck(dir);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /EISDIR/);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('.__somewhere')), []);
});

test('--watch reports a failed check and recovers on the next save', { timeout: 120_000 }, async () => {
  const dir = project({ 'src/a.ts': 'export const a = document.title;\n' });
  mkdirSync(join(dir, 'tsconfig.json'));
  const bin = fileURLToPath(new URL('../bin/somewhere.js', import.meta.url));
  const child = spawn(process.execPath, [bin, 'typecheck', '--deploy', '--watch', dir], { env: { ...process.env, NO_COLOR: '1' } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const until = async (pattern) => {
    const deadline = Date.now() + 60_000;
    while (!pattern.test(out)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`watch output never matched ${pattern}:\n${out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  try {
    await until(/Could not run the deploy check/);
    rmSync(join(dir, 'tsconfig.json'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = document.title; // saved\n');
    await until(/Deploy check clean/);
    assert.equal(child.exitCode, null, 'the watcher is still running');
  } finally {
    child.kill('SIGINT');
  }
});
