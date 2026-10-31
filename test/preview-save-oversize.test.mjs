import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPreviewSave } from '../dist/commands/dev.js';

// Preview's save loop posts changed files as a patch. A watched file that grows
// past the per-file limit refuses that save before anything is read or sent
// (the last preview stays as it was), and the save is held for the next one.
// Files the project ignores are never uploaded and never refuse a save.
const BIG = 6 * 1024 * 1024;
const queue = () => ({ pendingChanged: new Set(), pendingDeleted: new Set(), heldChanged: new Set(), heldDeleted: new Set() });

test('valid save is sent; the same file grown past the limit refuses and is held; ignored large files never refuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-preview-save-'));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, '.somewhereignore'), 'public/raw-video.mp4\n');
  writeFileSync(join(dir, 'public/hero.png'), Buffer.alloc(1024, 1));
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  const q = queue();

  // 1. A valid save goes out.
  q.pendingChanged.add('public/hero.png'); q.pendingChanged.add('index.html');
  let plan = planPreviewSave(dir, q);
  assert.equal(plan.action, 'send');
  assert.deepEqual(plan.upload.sort(), ['index.html', 'public/hero.png']);

  // 2. The same file grows past the limit, alongside an ordinary edit: nothing goes out.
  writeFileSync(join(dir, 'public/hero.png'), Buffer.alloc(BIG, 1));
  q.pendingChanged.add('public/hero.png'); q.pendingChanged.add('index.html');
  plan = planPreviewSave(dir, q);
  assert.equal(plan.action, 'refuse');
  assert.match(plan.message, /Nothing in this save was sent: this file is over the 5\.0 MB per-file limit/);
  assert.match(plan.message, /public\/hero\.png \(6\.0 MB\)/);
  assert.match(plan.message, /Your last preview is unchanged/);
  assert.deepEqual([...q.heldChanged].sort(), ['index.html', 'public/hero.png'], 'the refused save is held, not dropped');
  assert.equal(q.pendingChanged.size, 0, 'nothing pending, so the loop does not re-fire on its own');

  // 3. A large file the project ignores changes too: it is skipped, never a refusal.
  writeFileSync(join(dir, 'public/hero.png'), Buffer.alloc(2048, 1)); // fixed
  writeFileSync(join(dir, 'public/raw-video.mp4'), Buffer.alloc(BIG, 1));
  q.pendingChanged.add('public/raw-video.mp4');
  plan = planPreviewSave(dir, q);
  assert.equal(plan.action, 'send');
  assert.deepEqual(plan.upload.sort(), ['index.html', 'public/hero.png'], 'the held save goes out with this one; the ignored file does not');
  assert.equal(q.heldChanged.size, 0);
});

test('a deletion held with a refused save is sent with the next one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-preview-save-'));
  writeFileSync(join(dir, 'big.json'), 'x'.repeat(BIG));
  const q = queue();
  q.pendingChanged.add('big.json'); q.pendingDeleted.add('old.css');
  assert.equal(planPreviewSave(dir, q).action, 'refuse');
  writeFileSync(join(dir, 'big.json'), '{}');
  q.pendingChanged.add('big.json');
  const plan = planPreviewSave(dir, q);
  assert.equal(plan.action, 'send');
  assert.deepEqual(plan.upload, ['big.json']);
  assert.deepEqual(plan.deleted, ['old.css']);
});
