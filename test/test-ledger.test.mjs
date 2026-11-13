import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanSpec, hashesOf, recordRun, owedFor, projectFiles } from '../dist/lib/test-ledger.js';
import { formatDeployTestsLine, deployTestStatus } from '../dist/lib/deploy-tests.js';
import { confirmedRelease } from '../dist/lib/test-reporter.js';
import { starterTests } from '../dist/lib/init-test-template.js';

const SPEC = `import { test, expect } from '@somewhere-cloud/cli/testing';
const helper = (x: string) => x + ')'; // a bracket in a string
test('first', async ({ page }) => {
  await page.goto('/');
  expect(/\\)/.test(')')).toBe(true);
});
test(\`second\`, async () => {
  const s = \`template \${1 + (2)} }\`;
});
`;

function project() {
  const root = mkdtempSync(join(process.env.TMPDIR, 'ledger-'));
  mkdirSync(join(root, 'tests'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'tests/a.spec.ts'), SPEC);
  writeFileSync(join(root, 'tests/helpers.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'src/test-support.ts'), 'export const y = 1;\n');
  return root;
}
const ran = (status, title = 'first') => ({ id: 'id-' + title, file: 'tests/a.spec.ts', line: title === 'first' ? 3 : 7, titlePath: [title], project: '', status });
const base = { project: 'p', api: 'https://api.example/v1', origin: 'https://app.example', release: 'rel_1', platform: 'v1 1', env: 'e1', runner: '0.38.86 r1', browser: 'chrome 157', playwright: '1.65.0' };
const inputsOf = (root, over = {}) => ({ ...base, ...projectFiles(root), ...over });

test('scanning finds each test call through strings, regexes and templates', () => {
  const scanned = scanSpec(SPEC);
  assert.deepEqual(scanned.calls.map(call => call.title), ['first', 'second']);
  assert.ok(SPEC.slice(scanned.calls[0].start, scanned.calls[0].end).endsWith('})'));
  assert.equal(scanSpec('test(\'open\', () => {'), null, 'an unbalanced file is not trusted');
});

test('a test hash changes with its own body or the shared code, not with another test', () => {
  const root = project();
  const before = { first: hashesOf(root, 'tests/a.spec.ts', 'first'), second: hashesOf(root, 'tests/a.spec.ts', 'second') };
  writeFileSync(join(root, 'tests/a.spec.ts'), SPEC.replace("page.goto('/')", "page.goto('/x')"));
  assert.notEqual(hashesOf(root, 'tests/a.spec.ts', 'first').testHash, before.first.testHash);
  assert.equal(hashesOf(root, 'tests/a.spec.ts', 'second').testHash, before.second.testHash);
  assert.equal(hashesOf(root, 'tests/a.spec.ts', 'missing'), null);
});

test('a focused rerun keeps passes with the same inputs and reruns only what is owed', () => {
  const root = project();
  recordRun(root, { inputs: inputsOf(root), ran: [ran('failed', 'first'), ran('passed', 'second')], full: true });
  assert.deepEqual(owedFor(root, inputsOf(root)).ids, ['id-first']);
  writeFileSync(join(root, 'tests/a.spec.ts'), SPEC.replace("page.goto('/')", "page.goto('/fixed')"));
  const after = recordRun(root, { inputs: inputsOf(root), ran: [ran('passed', 'first')], full: false });
  // The sibling's spec file changed, so it is owed a run too (never kept across a spec edit).
  assert.deepEqual(after.kept, []);
  assert.deepEqual(after.owed.map(entry => [entry.title, entry.status]), [['second', 'needs-run']]);
  assert.equal(after.complete, true);
  const again = recordRun(root, { inputs: inputsOf(root), ran: [ran('passed', 'second')], full: false });
  assert.deepEqual(again.owed, []);
  assert.deepEqual(again.kept.map(entry => entry.title), ['first']);
  assert.equal(again.complete, true);
});

test('Astra M2.1-2.3: a helper outside tests/, the runner, the environment or the platform drops kept results', () => {
  for (const [what, change, says] of [
    ['helper in src/', root => writeFileSync(join(root, 'src/test-support.ts'), 'export const y = 2;\n'), /project files changed: src\/test-support\.ts/],
    ['dependency lock', root => writeFileSync(join(root, 'package-lock.json'), '{}'), /project files changed: package-lock\.json/],
    ['runner', () => ({ runner: '0.38.87 r2' }), /somewhere CLI that runs the tests changed/],
    ['environment variables', () => ({ env: 'e2' }), /environment variables changed/],
    ['platform', () => ({ platform: 'v2 2' }), /platform version changed/],
    ['API environment', () => ({ api: 'https://staging.example/v1' }), /API environment changed/],
    ['browser', () => ({ browser: 'chrome 158' }), /browser changed/],
  ]) {
    const root = project();
    recordRun(root, { inputs: inputsOf(root), ran: [ran('passed', 'first'), ran('failed', 'second')], full: true });
    const over = change(root) ?? {};
    const outcome = recordRun(root, { inputs: inputsOf(root, over), ran: [ran('passed', 'second')], full: false });
    assert.equal(outcome.kept.length, 0, what);
    assert.match(outcome.dropped.join(' | '), says, what);
    assert.equal(outcome.complete, false, `${what}: a subset after an input change is not a full result`);
  }
});

test('Astra M2.4: a failing test edited and not rerun stays owed; --failed still finds it', () => {
  const root = project();
  recordRun(root, { inputs: inputsOf(root), ran: [ran('passed', 'first'), ran('failed', 'second')], full: true });
  writeFileSync(join(root, 'tests/a.spec.ts'), SPEC.replace('template', 'changed template'));
  recordRun(root, { inputs: inputsOf(root), ran: [ran('passed', 'first')], full: false });
  const owed = owedFor(root, inputsOf(root));
  assert.deepEqual(owed.ids, ['id-second']);
});

test('Astra M2.5: a subset on a fresh ledger is not a complete result', () => {
  const root = project();
  const outcome = recordRun(root, { inputs: inputsOf(root), ran: [ran('passed', 'first')], full: false });
  assert.equal(outcome.complete, false);
  const owed = owedFor(root, inputsOf(root));
  assert.equal(owed.complete, false, '--failed must not say "do not run the suite again"');
});

test('a spec added after the full run makes the suite incomplete', () => {
  const root = project();
  recordRun(root, { inputs: inputsOf(root), ran: [ran('passed', 'first'), ran('passed', 'second')], full: true });
  writeFileSync(join(root, 'tests/b.spec.ts'), "test('third', async () => {});\n");
  assert.equal(recordRun(root, { inputs: inputsOf(root), ran: [ran('passed', 'first')], full: false }).complete, false);
});

test('kept results expire after the keep window', () => {
  const root = project();
  recordRun(root, { inputs: inputsOf(root), ran: [ran('passed', 'first'), ran('failed', 'second')], full: true, now: Date.now() - 31 * 60_000 });
  const outcome = recordRun(root, { inputs: inputsOf(root), ran: [ran('passed', 'second')], full: false });
  assert.equal(outcome.kept.length, 0);
  assert.match(outcome.dropped.join(' '), /older than 30 minutes/);
  assert.match(owedFor(root, inputsOf(root)).stale ?? 'not stale', /older than|not stale/);
});

test('Astra M1: a run whose release was not confirmed records nothing and keeps nothing', () => {
  const root = project();
  const outcome = recordRun(root, { inputs: null, ran: [ran('passed')], full: true });
  assert.equal(outcome.kept.length, 0);
  assert.throws(() => readFileSync(join(root, '.somewhere/tests/ledger.json')), /ENOENT/);
  assert.equal(confirmedRelease('rel_1', ['rel_1'], 'rel_2'), null, 'R1 at start, R2 at the end');
  assert.equal(confirmedRelease('rel_1', ['rel_1'], null), null, 'final lookup failed');
  assert.equal(confirmedRelease('rel_1', ['rel_1', 'rel_2'], 'rel_1'), null, 'a fixture saw another release');
  assert.equal(confirmedRelease('rel_1', ['rel_1'], 'rel_1'), 'rel_1');
  // deploy --test: an exit code of 0 with a changed or unconfirmed release is never passed.
  assert.equal(deployTestStatus(0, { release: 'release changed during run', releaseConfirmed: false }, 'rel_1').status, 'failed');
  assert.equal(deployTestStatus(0, { release: 'rel_2', releaseConfirmed: true }, 'rel_1').status, 'failed');
  assert.equal(deployTestStatus(0, { release: 'rel_1', releaseConfirmed: true }, 'rel_1').status, 'passed');
  assert.equal(deployTestStatus(1, { release: 'rel_1', releaseConfirmed: true }, 'rel_1').status, 'failed');
});

test('deploy --test never reports a failed or skipped test run as green', () => {
  assert.match(formatDeployTestsLine({ status: 'failed', release: 'rel_1', results: { passed: 3, failed: 1 } }), /^The deploy is live\. Its tests FAILED: 1 failed, 3 passed/);
  assert.match(formatDeployTestsLine({ status: 'not_run', release: 'rel_1', reason: 'x' }), /^The deploy is live\. Its tests did NOT run: x/);
  assert.match(formatDeployTestsLine({ status: 'passed', release: 'rel_1', results: { passed: 4 } }), /live and its tests passed: 4 passed/);
  assert.match(formatDeployTestsLine({ status: 'passed', release: 'rel_1', results: { passed: 2, skipped: 2 } }), /2 passed, 2 skipped \(a skipped test proves nothing\)/);
});

test('starter journeys: private data runs, other access journeys wait to be filled in, refusals carry a positive control', () => {
  const notes = starterTests({ privateData: true }).find(file => file.path === 'tests/access.spec.ts').content;
  assert.match(notes, /table: 'notes'/);
  assert.match(notes, /\{ allowed: owner \}/);
  const minimal = starterTests({ minimal: true });
  assert.deepEqual(minimal.map(file => file.path), ['tests/account.spec.ts', 'tests/phone.spec.ts', 'tests/access.spec.ts']);
  assert.match(minimal[0].content, /steps: viaAuthRoute\('\/api\/auth\/signup'\)/);
  assert.match(minimal[2].content, /expectRefused\(anonymous, 'greetings'/);
  for (const file of [...starterTests(), ...minimal]) assert.ok(file.content.split('\n').length <= 60, `${file.path} fits one screen`);
});
