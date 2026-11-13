import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanSpec, hashesOf, recordRun, failedOnRelease } from '../dist/lib/test-ledger.js';
import { formatDeployTestsLine } from '../dist/lib/deploy-tests.js';
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
  writeFileSync(join(root, 'tests/a.spec.ts'), SPEC);
  writeFileSync(join(root, 'tests/helpers.ts'), 'export const x = 1;\n');
  return root;
}
const ran = (status, title = 'first') => ({ id: 'id-' + title, file: 'tests/a.spec.ts', line: title === 'first' ? 3 : 7, titlePath: [title], project: '', status });

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
  writeFileSync(join(root, 'tests/a.spec.ts'), SPEC.replace("x + ')'", "x + ']'"));
  assert.notEqual(hashesOf(root, 'tests/a.spec.ts', 'second').testHash, before.second.testHash, 'shared spec code counts for every test');
  assert.equal(hashesOf(root, 'tests/a.spec.ts', 'missing'), null);
});

test('a focused rerun keeps passes on the same release and reruns only what failed', () => {
  const root = project();
  recordRun(root, { projectId: 'p', release: 'rel_1', ran: [ran('failed', 'first'), ran('passed', 'second')] });
  const focus = failedOnRelease(root, 'p', 'rel_1');
  assert.deepEqual(focus.ids, ['id-first']);
  writeFileSync(join(root, 'tests/a.spec.ts'), SPEC.replace("page.goto('/')", "page.goto('/fixed')"));
  const after = recordRun(root, { projectId: 'p', release: 'rel_1', ran: [ran('passed', 'first')] });
  assert.deepEqual(after.kept.map(entry => [entry.title, entry.status, entry.release]), [['second', 'passed', 'rel_1']]);
  assert.deepEqual(after.dropped, []);
  assert.equal(after.all.every(entry => entry.status === 'passed'), true);
  assert.match(failedOnRelease(root, 'p', 'rel_1').ids.length === 0 ? 'none' : 'some', /none/);
});

test('a new release, a shared helper or a changed test drops kept results and says why', () => {
  const root = project();
  recordRun(root, { projectId: 'p', release: 'rel_1', ran: [ran('passed', 'first'), ran('passed', 'second')] });
  const released = recordRun(root, { projectId: 'p', release: 'rel_2', ran: [ran('passed', 'first')] });
  assert.equal(released.kept.length, 0);
  assert.match(released.dropped[0], /release changed \(rel_1 → rel_2\)/);
  assert.match(failedOnRelease(root, 'p', 'rel_3').stale, /release changed/);

  recordRun(root, { projectId: 'p', release: 'rel_2', ran: [ran('passed', 'first'), ran('passed', 'second')] });
  writeFileSync(join(root, 'tests/helpers.ts'), 'export const x = 2;\n');
  const helper = recordRun(root, { projectId: 'p', release: 'rel_2', ran: [ran('passed', 'first')] });
  assert.equal(helper.kept.length, 0);
  assert.match(helper.dropped[0], /shared test files changed: tests\/helpers\.ts/);

  recordRun(root, { projectId: 'p', release: 'rel_2', ran: [ran('passed', 'first'), ran('passed', 'second')] });
  writeFileSync(join(root, 'tests/a.spec.ts'), SPEC.replace('template', 'changed template'));
  const changed = recordRun(root, { projectId: 'p', release: 'rel_2', ran: [ran('passed', 'first')] });
  assert.equal(changed.kept.length, 0);
  assert.deepEqual(changed.changedFiles, ['tests/a.spec.ts']);
  assert.match(changed.dropped[0], /a\.spec\.ts › second/);
});

test('a run whose release could not be confirmed records nothing', () => {
  const root = project();
  const outcome = recordRun(root, { projectId: 'p', release: null, ran: [ran('passed')] });
  assert.equal(outcome.kept.length, 0);
  assert.throws(() => readFileSync(join(root, '.somewhere/tests/ledger.json')), /ENOENT/);
});

test('deploy --test never reports a failed or skipped test run as green', () => {
  assert.match(formatDeployTestsLine({ status: 'failed', release: 'rel_1', results: { passed: 3, failed: 1 } }), /^The deploy is live\. Its tests FAILED: 1 failed, 3 passed/);
  assert.match(formatDeployTestsLine({ status: 'not_run', release: 'rel_1', reason: 'x' }), /^The deploy is live\. Its tests did NOT run: x/);
  assert.match(formatDeployTestsLine({ status: 'passed', release: 'rel_1', results: { passed: 4 } }), /live and its tests passed: 4 passed/);
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
