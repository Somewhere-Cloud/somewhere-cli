import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryLines, parseChangelog, plainTitle, renderChangelog } from '../scripts/release-notes.mjs';

test('the changelog is rewritten newest first, whatever order the sections were in', () => {
  const sections = parseChangelog('## 0.38.36\n\n- late\n\n# Changelog\n\n## 0.38.85\n\n- new\n\n## 0.38.9\n\n- old\n');
  assert.equal(renderChangelog(sections), '# Changelog\n\n## 0.38.85\n\n- new\n\n## 0.38.36\n\n- late\n\n## 0.38.9\n\n- old\n');
});

test('pull request titles become plain lines; release and sync commits do not', () => {
  assert.equal(plainTitle('fix(deploy): name the uploaded paths; release 0.38.31 (tsk_23f34679, tsk_a3dde3d6) (#195)'), 'Name the uploaded paths.');
  assert.equal(plainTitle('somewhere test shows the failing assertion (#273)'), 'somewhere test shows the failing assertion.');
  assert.equal(plainTitle('Release 0.38.84'), null);
  assert.equal(plainTitle('Refresh platform vendors for lockstep (#223)'), null);
});

test('a release with only platform rule updates still says what changed', () => {
  assert.equal(entryLines(['Release 0.38.67'], ['package.json', 'runtime/SOURCE-LINT-VENDOR.json']), "- Lint checks match the platform's current rules.");
  assert.equal(entryLines([], ['package.json']), '- Maintenance release: commands work as in the previous version.');
});
