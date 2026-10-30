import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// pfb_f3cc58a01e76, tsk_746516: tests are not part of the app. A test source
// file (`*.test.*`, `*.spec.*`) and anything in a `tests/` or `__tests__/`
// folder is held back by default and named as not published; under api/ a
// test file would otherwise deploy as a live route. An app that imports
// helpers from a test folder publishes them explicitly (`--include tests`,
// `!tests/`), and no opt-in reopens the ignore, dotfile or secret exclusions.
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'lib', 'files.js');
const { collectFiles, isTestSourcePath, testFolderOf } = await import(pathToFileURL(dist).href);

function app(files) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-test-files-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const uploaded = (c) => [...Object.keys(c.files), ...Object.keys(c.binaryFiles), ...Object.keys(c.functions)].sort();
const excludedPaths = (c) => c.excluded.map((e) => e.path);

// Files an app legitimately ships, several with test-like names.
const APP = {
  'index.html': '<html><body><script type="module" src="/src/main.tsx"></script></body></html>\n',
  'src/main.tsx': 'import "./App";\n',
  'src/App.tsx': 'export const App = 1;\n',
  'package.json': '{"name":"a","private":true}\n',
  'tsconfig.json': '{"compilerOptions":{"strict":true}}\n',
  'vite.config.ts': 'export default {};\n',
  'postcss.config.js': 'module.exports = {};\n',
  '.well-known/security.txt': 'Contact: mailto:security@example.com\n',
  'public/.well-known/assetlinks.json': '[]\n',
  'api/slots.ts': 'export default async () => new Response("ok");\n',
  'api/test.ts': 'export default async () => new Response("a route named test");\n',
  'api/tests.ts': 'export default async () => new Response("a route file named tests");\n',
  'api/testimonials.ts': 'export default async () => new Response("[]");\n',
  'src/testsuite/runner.ts': 'export const runner = 1;\n',
  'src/contests/list.ts': 'export const list = 1;\n',
  'src/latest.spec-sheet.ts': 'export const sheet = 1;\n',
  'public/openapi.spec.json': '{}\n',
  'e2e/run.mjs': 'export const run = 1;\n',
};
const APP_KEPT = [
  'index.html', 'src/main.tsx', 'src/App.tsx', 'package.json', 'tsconfig.json', 'vite.config.ts', 'postcss.config.js',
  '.well-known/security.txt', 'api/slots.ts', 'api/test.ts', 'api/tests.ts', 'api/testimonials.ts',
  'src/testsuite/runner.ts', 'src/contests/list.ts', 'src/latest.spec-sheet.ts', 'e2e/run.mjs',
];
const TESTS = {
  'api/slots.test.ts': 'test("x", () => {});\n',
  'src/App.spec.tsx': 'it("renders", () => {});\n',
  'tests/helpers.ts': 'export const helper = 1;\n',
  'tests/booking.test.mjs': 'test("y", () => {});\n',
  '__tests__/util.js': 'export const util = 1;\n',
  'src/__tests__/App.ts': 'export const fixture = 1;\n',
  'api/tests/seed.ts': 'export default async () => new Response("seed");\n',
};

test('tests stay home by default; app files with test-like names, config, e2e/ and .well-known upload', () => {
  const c = collectFiles(app({ ...APP, ...TESTS }));
  const up = uploaded(c);
  for (const kept of APP_KEPT) assert.ok(up.includes(kept), `${kept} uploads`);
  assert.ok(up.includes('openapi.spec.json') || up.includes('public/openapi.spec.json'), 'a .spec. data file uploads');
  assert.ok(up.includes('.well-known/assetlinks.json') || up.includes('public/.well-known/assetlinks.json'), 'public/.well-known uploads');
  for (const held of Object.keys(TESTS)) {
    assert.ok(!up.includes(held), `${held} does not upload`);
    assert.ok(excludedPaths(c).includes(held), `${held} is named as not published`);
  }
  assert.ok(!('api/slots.test.ts' in c.functions) && !('api/tests/seed.ts' in c.functions), 'no test becomes a function route');
  const reason = (p) => c.excluded.find((e) => e.path === p).reason;
  assert.match(reason('api/slots.test.ts'), /--include api\/slots\.test\.ts/);
  assert.match(reason('tests/helpers.ts'), /--include tests` or a "!tests\/" line/);
  assert.match(reason('src/__tests__/App.ts'), /--include src\/__tests__` or a "!src\/__tests__\/" line/);
  assert.deepEqual(excludedPaths(c), [...excludedPaths(c)].sort((a, b) => a.localeCompare(b)), 'held-back files are listed in order');
});

test('"!tests/" or --include tests publishes imported helpers; test-named files need their own opt-in; secrets stay closed', () => {
  const dir = app({
    ...APP,
    ...TESTS,
    'tests/.env': 'SECRET=3\n',
    '.env': 'SECRET=1\n',
    '.env.local': 'SECRET=2\n',
    '.somewhereignore': '!tests/\n!src/__tests__/App.ts\n!.env\n!tests/.env\n',
  });
  const viaIgnore = collectFiles(dir);
  const up = uploaded(viaIgnore);
  assert.ok(up.includes('tests/helpers.ts'), '"!tests/" re-includes a helper inside the folder');
  assert.ok(up.includes('src/__tests__/App.ts'), 'a "!" line naming one file inside __tests__/ re-includes it');
  assert.ok(!up.includes('tests/booking.test.mjs'), 'a test-named file inside a re-included folder still needs its own opt-in');
  assert.ok(up.includes('api/tests/seed.ts'), 'an unanchored "!tests/" covers every folder named tests, as in .gitignore');
  for (const held of ['__tests__/util.js', 'api/slots.test.ts', 'src/App.spec.tsx']) {
    assert.ok(!up.includes(held), `${held} stays home without its own opt-in`);
  }
  const anchored = uploaded(collectFiles(app({ ...APP, ...TESTS, '.somewhereignore': '!/tests/\n' })));
  assert.ok(anchored.includes('tests/helpers.ts') && !anchored.includes('api/tests/seed.ts'), '"!/tests/" re-includes only the root folder');
  for (const secret of ['.env', '.env.local', 'tests/.env', '.somewhereignore']) {
    assert.ok(!up.includes(secret), `${secret} never uploads, even with a "!" line`);
  }

  const viaFlag = collectFiles(app({ ...APP, ...TESTS, '.env': 'SECRET=1\n' }), {
    include: ['tests/', 'api/slots.test.ts', '.env'],
  });
  const upFlag = uploaded(viaFlag);
  assert.ok(upFlag.includes('tests/helpers.ts'), '--include tests/ re-includes the folder');
  assert.ok(!upFlag.includes('tests/booking.test.mjs'), 'but not a test-named file inside it');
  assert.ok('api/slots.test.ts' in viaFlag.functions, 'an opted-in test file under api/ is a function, as asked');
  assert.ok(!upFlag.includes('src/__tests__/App.ts'), 'other test folders stay home');
  assert.ok(!upFlag.includes('.env'), '--include never reopens .env');
});

test('isTestSourcePath and testFolderOf match tests only', () => {
  for (const p of ['a.test.ts', 'src/App.test.tsx', 'x.spec.js', 'y.spec.mjs', 'z.test.cjs', 'deep/w.spec.jsx', 'v.test.mts']) {
    assert.equal(isTestSourcePath(p), true, p);
  }
  for (const p of ['testimonials.ts', 'api/test.ts', 'tests/helpers.ts', 'openapi.spec.json', 'latest.ts', 'spec.ts', 'contest.ts', 'a.test.md', 'src/latest.spec-sheet.ts']) {
    assert.equal(isTestSourcePath(p), false, p);
  }
  assert.equal(testFolderOf('tests/a.ts'), 'tests');
  assert.equal(testFolderOf('src/__tests__/a.ts'), 'src/__tests__');
  assert.equal(testFolderOf('api/tests/seed.ts'), 'api/tests');
  for (const p of ['api/tests.ts', 'src/testsuite/a.ts', 'src/contests/a.ts', 'e2e/run.mjs', 'tests']) {
    assert.equal(testFolderOf(p), null, p);
  }
});
