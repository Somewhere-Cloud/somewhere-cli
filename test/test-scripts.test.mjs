import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { hasSpecFiles, listScripts, runScripts, describeScriptResults, recordScriptResults, lastFailedScripts } = await import('../dist/lib/test-scripts.js');

function project(files) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'sw-test-scripts-'));
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); }
  return root;
}

test('somewhere test with no specs runs every tests/*.mjs and *.cjs script and reports failures first, one line each', async () => {
  const root = project({
    'tests/app-check.mjs': "console.log('PASS the signed-in page shows the account');\n",
    'tests/e2e.cjs': "console.log('PASS sign up'); console.log('FAIL owner adds a member - member-error never appeared'); process.exit(1);\n",
    'tests/helper.json': '{}',
  });
  assert.equal(hasSpecFiles(root), false);
  const scripts = listScripts(root, []);
  assert.deepEqual(scripts, ['tests/app-check.mjs', 'tests/e2e.cjs']);
  const results = await runScripts(root, scripts, [], process.env);
  const lines = describeScriptResults(results);
  assert.deepEqual(lines, [
    'FAIL tests/e2e.cjs: owner adds a member - member-error never appeared',
    'PASS tests/app-check.mjs',
    'FAILED: 1 of 2 checks in 2 scripts',
    'Next: fix what each FAIL line names, run npx @somewhere-cloud/cli deploy, then npx @somewhere-cloud/cli test --failed to rerun only what failed.',
  ]);
  recordScriptResults(root, results, false);
  assert.deepEqual(lastFailedScripts(root), ['tests/e2e.cjs'], '--failed reruns only the failed script');
});

test('a project with specs keeps the spec runner; an empty tests/ says what to add', () => {
  assert.equal(hasSpecFiles(project({ 'tests/team.spec.ts': '' })), true);
  assert.match(describeScriptResults([])[0], /^No tests found: add a Playwright script as tests\/<name>\.mjs or \.cjs/);
});

test('a script that hands over its checks gets one line per check, one summary line, and its result file only after a failure', async () => {
  const report = (checks) => `require('node:fs').writeFileSync(process.env.SW_TEST_REPORT, JSON.stringify({ checks: ${JSON.stringify('CHECKS')}, resultFile: '.somewhere/app-check.json' }));\n`.replace('"CHECKS"', JSON.stringify(checks));
  const passing = project({ 'tests/app-check.cjs': report([{ name: 'the signed-in page shows the account', ok: true }, { name: 'sign out, then sign back in', ok: true }, { name: 'at phone width nothing scrolls sideways', ok: true }]) });
  const ok = describeScriptResults(await runScripts(passing, listScripts(passing, []), [], process.env));
  assert.deepEqual(ok, ['PASS the signed-in page shows the account', 'PASS sign out, then sign back in', 'PASS at phone width nothing scrolls sideways', 'PASSED: 3 checks in 1 script']);
  assert.match(describeScriptResults(await runScripts(passing, listScripts(passing, []), [], process.env), { verbose: true }).at(-1), /^Full result: \.somewhere\/app-check\.json$/);
  const failing = project({ 'tests/app-check.cjs': report([{ name: 'sign up', ok: true }, { name: 'owner adds a member', ok: false, error: 'member-error never appeared\npage 1: …' }, { name: 'phone width', ok: false, skipped: 'after-failure' }]) + 'process.exitCode = 1;\n' });
  assert.deepEqual(describeScriptResults(await runScripts(failing, listScripts(failing, []), [], process.env)), [
    'FAIL owner adds a member: member-error never appeared',
    'PASS sign up',
    'NOT RUN phone width (after the first failure)',
    'FAILED: 1 of 3 checks in 1 script (1 not run)',
    'Next: fix what each FAIL line names, run npx @somewhere-cloud/cli deploy, then npx @somewhere-cloud/cli test --failed to rerun only what failed.',
    'Full result: .somewhere/app-check.json',
  ]);
});
