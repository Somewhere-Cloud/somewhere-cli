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
  assert.match(lines[0], /^FAIL tests\/e2e\.cjs \(exit 1, [\d.]+ s\): owner adds a member - member-error never appeared$/);
  assert.match(lines[1], /^PASS tests\/app-check\.mjs/);
  assert.match(lines.at(-1), /^FAILED: 1 of 2 scripts failed\. Fix what each FAIL line names, run somewhere deploy, then somewhere test --failed/);
  recordScriptResults(root, results, false);
  assert.deepEqual(lastFailedScripts(root), ['tests/e2e.cjs'], '--failed reruns only the failed script');
});

test('a project with specs keeps the spec runner; an empty tests/ says what to add', () => {
  assert.equal(hasSpecFiles(project({ 'tests/team.spec.ts': '' })), true);
  assert.match(describeScriptResults([])[0], /^No tests found: add a Playwright script as tests\/<name>\.mjs or \.cjs/);
});
