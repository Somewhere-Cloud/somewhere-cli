import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// pfb_f3cc58a01e76: test source files (`*.test.*`, `*.spec.*`) are not
// uploaded by default — under api/ one would deploy as a live route. Test
// folders still upload as private source (the platform never serves them), so
// app imports from them resolve. An explicit opt-in re-includes a test file,
// including one inside a test folder, and never reopens the hard exclusions.
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'lib', 'files.js');
const { collectFiles, isTestSourcePath } = await import(pathToFileURL(dist).href);

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

const BASE = {
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
  'api/testimonials.ts': 'export default async () => new Response("[]");\n',
  'src/latest.spec-sheet.ts': 'export const sheet = 1;\n',
  'public/openapi.spec.json': '{}\n',
  'tests/helpers.ts': 'export const helper = 1;\n',
  'e2e/run.mjs': 'export const run = 1;\n',
};

test('test source files stay home; app files with test-like names, test folders, config and .well-known upload', () => {
  const dir = app({
    ...BASE,
    'api/slots.test.ts': 'test("x", () => {});\n',
    'src/App.spec.tsx': 'it("renders", () => {});\n',
    'tests/booking.test.mjs': 'test("y", () => {});\n',
    '__tests__/util.spec.js': 'it("z", () => {});\n',
  });
  const c = collectFiles(dir);
  const up = uploaded(c);
  for (const kept of [
    'index.html', 'src/main.tsx', 'src/App.tsx', 'package.json', 'tsconfig.json', 'vite.config.ts', 'postcss.config.js',
    '.well-known/security.txt', 'api/slots.ts', 'api/test.ts', 'api/testimonials.ts', 'src/latest.spec-sheet.ts',
    'tests/helpers.ts', 'e2e/run.mjs',
  ]) assert.ok(up.includes(kept), `${kept} uploads`);
  assert.ok(up.includes('openapi.spec.json') || up.includes('public/openapi.spec.json'), 'a .spec. data file uploads');
  assert.ok(up.includes('.well-known/assetlinks.json') || up.includes('public/.well-known/assetlinks.json'), 'public/.well-known uploads');
  for (const held of ['api/slots.test.ts', 'src/App.spec.tsx', 'tests/booking.test.mjs', '__tests__/util.spec.js']) {
    assert.ok(!up.includes(held), `${held} does not upload`);
    assert.ok(excludedPaths(c).includes(held), `${held} is named as not published`);
  }
  assert.ok(!('api/slots.test.ts' in c.functions), 'a test file under api/ never becomes a function');
  assert.match(c.excluded.find((e) => e.path === 'api/slots.test.ts').reason, /--include api\/slots\.test\.ts/);
  assert.deepEqual(excludedPaths(c), [...excludedPaths(c)].sort(), 'held-back files are listed in order');
});

test('a "!" line or --include re-includes a test file, also inside a test folder; hard exclusions stay closed', () => {
  const dir = app({
    ...BASE,
    'tests/fixtures.test.ts': 'export const fixture = 1;\n',
    'api/health.spec.ts': 'export default async () => new Response("ok");\n',
    'src/a.test.ts': 'test("a", () => {});\n',
    '.env': 'SECRET=1\n',
    '.env.local': 'SECRET=2\n',
    'tests/.env': 'SECRET=3\n',
    '.somewhereignore': '!tests/fixtures.test.ts\n!.env\n!tests/.env\n',
  });
  const viaIgnore = collectFiles(dir);
  const up = uploaded(viaIgnore);
  assert.ok(up.includes('tests/fixtures.test.ts'), 'a "!" line re-includes a test file inside tests/');
  assert.ok(!up.includes('api/health.spec.ts') && !up.includes('src/a.test.ts'), 'other test files stay home');
  for (const secret of ['.env', '.env.local', 'tests/.env', '.somewhereignore']) {
    assert.ok(!up.includes(secret), `${secret} never uploads, even with a "!" line`);
  }

  const viaFlag = collectFiles(dir, { include: ['api/health.spec.ts', '.env'] });
  assert.ok(uploaded(viaFlag).includes('api/health.spec.ts'), '--include re-includes a test file');
  assert.ok('api/health.spec.ts' in viaFlag.functions, 'an opted-in test file under api/ is a function, as asked');
  assert.ok(!uploaded(viaFlag).includes('.env'), '--include never reopens .env');
});

test('isTestSourcePath matches test runner source names only', () => {
  for (const p of ['a.test.ts', 'src/App.test.tsx', 'x.spec.js', 'y.spec.mjs', 'z.test.cjs', 'deep/w.spec.jsx', 'v.test.mts']) {
    assert.equal(isTestSourcePath(p), true, p);
  }
  for (const p of ['testimonials.ts', 'api/test.ts', 'tests/helpers.ts', 'openapi.spec.json', 'latest.ts', 'spec.ts', 'contest.ts', 'a.test.md', 'src/latest.spec-sheet.ts']) {
    assert.equal(isTestSourcePath(p), false, p);
  }
});
