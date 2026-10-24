import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The shared module is vendored byte-identical; the manifest's sha256 is the platform file's own.
test('vendored repro-guidance matches its manifest and stays dependency-free', () => {
  const dir = join(import.meta.dirname, '..', 'src/lib/vendor');
  const text = readFileSync(join(dir, 'repro-guidance.ts'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(dir, 'REPRO-GUIDANCE-VENDOR.json'), 'utf8'));
  assert.equal(manifest.source, 'shared/repro-guidance.ts');
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  assert.equal(createHash('sha256').update(text).digest('hex'), manifest.sha256);
  assert.doesNotMatch(text, /^import /m, 'the shared module has no imports');
});

test('exact site_verify uses browser schema guidance while unknown tool names stay general', async () => {
  const { buildPacket, buildRecordFromFields } = await import('../dist/lib/vendor/repro-guidance.js');
  const packet = (tool) => buildPacket(buildRecordFromFields({ platform: true, tool, code: 'VALIDATION_ERROR', status: 400 },
    { client: { kind: 'cli', version: '0.37.77' } }));
  const known = packet('site_verify');
  assert.equal(known.surface, 'browser_verify');
  assert.deepEqual(known.recipe.investigate, [['somewhere', 'verify', '--schema'], ['somewhere', 'docs', 'browser']]);
  for (const name of ['site_verify_extra', 'unknown_tool']) {
    assert.equal(packet(name).surface, 'general');
    assert.deepEqual(packet(name).recipe.investigate, [['somewhere', 'logs', '--project', '<PROJECT>']]);
  }
});
