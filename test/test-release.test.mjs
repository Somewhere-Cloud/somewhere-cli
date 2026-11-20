import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDeployTestsLine, deployTestStatus } from '../dist/lib/deploy-tests.js';
import { confirmedRelease } from '../dist/lib/test-reporter.js';
import { starterChecks } from '../dist/lib/init-test-template.js';
import { collectFiles } from '../dist/lib/files.js';
import { hasSpecFiles, listScripts } from '../dist/lib/test-scripts.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

test('a run is tied to one release only when start, fixtures and end agree', () => {
  assert.equal(confirmedRelease('rel_1', ['rel_1'], 'rel_2'), null, 'R1 at start, R2 at the end');
  assert.equal(confirmedRelease('rel_1', ['rel_1'], null), null, 'final lookup failed');
  assert.equal(confirmedRelease('rel_1', ['rel_1', 'rel_2'], 'rel_1'), null, 'a fixture saw another release');
  assert.equal(confirmedRelease('rel_1', ['rel_1'], 'rel_1'), 'rel_1');
});

test('deploy --test is passed only for the release it published, and never green when tests fail or skip', () => {
  assert.equal(deployTestStatus(0, { release: 'release changed during run', releaseConfirmed: false }, 'rel_1').status, 'failed');
  assert.equal(deployTestStatus(0, { release: 'rel_2', releaseConfirmed: true }, 'rel_1').status, 'failed');
  assert.equal(deployTestStatus(0, { release: 'rel_1', releaseConfirmed: true }, 'rel_1').status, 'passed');
  assert.equal(deployTestStatus(1, { release: 'rel_1', releaseConfirmed: true }, 'rel_1').status, 'failed');
  assert.match(formatDeployTestsLine({ status: 'failed', release: 'rel_1', results: { passed: 3, failed: 1 } }), /^The deploy is live\. Its tests FAILED: 1 failed, 3 passed/);
  assert.match(formatDeployTestsLine({ status: 'not_run', release: 'rel_1', reason: 'x' }), /^The deploy is live\. Its tests did NOT run: x/);
  assert.match(formatDeployTestsLine({ status: 'passed', release: 'rel_1', results: { passed: 2, skipped: 2 } }), /2 passed, 2 skipped \(a skipped test proves nothing\)/);
});

test('the starter saves its journey as checks/add-a-note.json, which deploy publishes and no local runner picks up', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sw-starter-checks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(starterChecks({ privateData: false }), [], 'no notes form, no saved check');
  const files = starterChecks({ privateData: true });
  assert.deepEqual(files.map(file => file.path), ['checks/add-a-note.json']);
  const check = JSON.parse(files[0].content);
  assert.equal(check.signed_in, true);
  assert.deepEqual(check.viewports, ['desktop', 'mobile']);
  mkdirSync(join(root, 'checks'), { recursive: true });
  writeFileSync(join(root, files[0].path), files[0].content);
  writeFileSync(join(root, 'index.html'), '<h1>app</h1>');
  assert.deepEqual(listScripts(root, []), []);
  const collected = collectFiles(root);
  assert.ok(collected.published.includes('checks/add-a-note.json'), 'deploy publishes checks/*.json');
  assert.deepEqual(collected.excluded.filter(e => e.path.startsWith('checks/')), []);
});
