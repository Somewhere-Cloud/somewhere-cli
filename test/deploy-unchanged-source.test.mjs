import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unchangedSinceLastPublish } from '../dist/commands/deploy.js';
import { hashFiles, saveBaseFiles } from '../dist/lib/base-files.js';

const project = 'proj_1';
const release = 'rel_1';

function folder() {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'sw-unchanged-'));
  writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(dir, 'app.ts'), 'export const a = 1;');
  const config = { project_id: project, source_base: { project_id: project, release_id: release, at: 'x' } };
  saveBaseFiles(dir, { project_id: project, release_id: release, files: hashFiles(dir, ['index.html', 'app.ts']) });
  return { dir, entry: { dir, config } };
}

test('a redeploy of exactly the last published files skips the local type check', () => {
  const { dir, entry } = folder();
  assert.equal(unchangedSinceLastPublish(entry, dir, hashFiles(dir, ['index.html', 'app.ts'])), true);
});

test('an edited, added or removed file is checked again', () => {
  const { dir, entry } = folder();
  writeFileSync(join(dir, 'app.ts'), 'export const a: number = "x";');
  assert.equal(unchangedSinceLastPublish(entry, dir, hashFiles(dir, ['index.html', 'app.ts'])), false);
  const second = folder();
  writeFileSync(join(second.dir, 'more.ts'), '');
  assert.equal(unchangedSinceLastPublish(second.entry, second.dir, hashFiles(second.dir, ['index.html', 'app.ts', 'more.ts'])), false);
  assert.equal(unchangedSinceLastPublish(second.entry, second.dir, hashFiles(second.dir, ['index.html'])), false);
});

test('no record, another release, or another folder means a check', () => {
  const { dir, entry } = folder();
  const hashes = hashFiles(dir, ['index.html', 'app.ts']);
  assert.equal(unchangedSinceLastPublish(null, dir, hashes), false);
  const moved = { ...entry, config: { ...entry.config, source_base: { project_id: project, release_id: 'rel_2', at: 'x' } } };
  assert.equal(unchangedSinceLastPublish(moved, dir, hashes), false);
  assert.equal(unchangedSinceLastPublish({ ...entry, dir: join(dir, '..') }, dir, hashes), false);
});
