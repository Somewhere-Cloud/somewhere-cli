import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDeployTestsLine, deployTestStatus } from '../dist/lib/deploy-tests.js';
import { confirmedRelease } from '../dist/lib/test-reporter.js';
import { starterTests } from '../dist/lib/init-test-template.js';
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

test('the starter ships one ordinary script that somewhere test discovers and can clean up', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sw-starter-test-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const privateData of [false, true]) {
    const files = starterTests({ privateData });
    assert.deepEqual(files.map(file => file.path), ['tests/app-check.mjs']);
    const script = files[0].content;
    const scriptPath = join(root, files[0].path);
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, script);
    assert.equal(hasSpecFiles(root), false);
    assert.deepEqual(listScripts(root, []), [join('tests', 'app-check.mjs')]);
    assert.match(script, /from '@somewhere-cloud\/cli\/script'/);
    assert.match(script, /chromium\.launch\(app\.launchOptions\(\)\)/);
    assert.match(script, /npx @somewhere-cloud\/cli deploy && npx @somewhere-cloud\/cli test/);
    assert.match(script, /finally\s*\{\s*await app\.finish\(\)/);
    assert.match(script, /at phone width nothing scrolls sideways/);
    assert.doesNotMatch(script, /waitForTimeout|setTimeout/, 'no fixed sleeps');
    assert.ok(script.split('\n').length <= (privateData ? 80 : 70), 'keeps the starter short even with the private-data journey');
    if (privateData) {
      assert.match(script, /captureResponses\(ben\.page\)/);
      assert.match(script, /await dataReady\(ben\.page\)/);
      assert.match(script, /expectRefused\(ben\.page, \{ table: 'notes', operation: 'update'/);
      assert.match(script, /\{ allowed: ana\.page \}/);
    }
  }
});
