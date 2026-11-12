import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
test('runtime content digest and selected source projection agree', t => {
  const root = join(import.meta.dirname, '..');
  const hash = createHash('sha256');
  for (const file of ['declared-data.cjs', 'source-lint.cjs']) hash.update(file + '\0').update(readFileSync(join(root, 'runtime', file)));
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'runtime/PLATFORM-SOURCE.json'))), { sha256: hash.digest('hex') });
  const source = process.env.SOMEWHERE_VENDOR_SOURCE;
  if (!source) { t.skip('Set SOMEWHERE_VENDOR_SOURCE to verify against a selected source checkout'); return; }
  for (const helper of ['declared-data', 'source-lint', 'deploy-paths', 'repro-guidance']) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/vendor-' + helper + '.mjs'), source, '--check'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
});
