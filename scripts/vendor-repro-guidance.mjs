#!/usr/bin/env node
// Vendor (or prove byte parity with) the platform's shared repro-packet module, shared/repro-guidance.ts.
// The copy is byte-identical, so its sha256 is the platform file's own; the manifest pins the source commit.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [sourceRoot, mode] = process.argv.slice(2);
if (!sourceRoot || (mode && mode !== '--check')) throw new Error('Usage: node scripts/vendor-repro-guidance.mjs <platform-source> [--check]');
const root = resolve(sourceRoot);
const SOURCE = 'shared/repro-guidance.ts';
const text = readFileSync(join(root, SOURCE), 'utf8');
const sha256 = createHash('sha256').update(text).digest('hex');
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dest = join(import.meta.dirname, '..', 'src/lib/vendor');
const manifest = JSON.stringify({ source: SOURCE, commit, sha256 }, null, 2) + '\n';
if (mode === '--check') {
  if (readFileSync(join(dest, 'repro-guidance.ts'), 'utf8') !== text) throw new Error('src/lib/vendor/repro-guidance.ts differs from the platform source; re-vendor it.');
  const pinned = JSON.parse(readFileSync(join(dest, 'REPRO-GUIDANCE-VENDOR.json'), 'utf8'));
  if (pinned.sha256 !== sha256) throw new Error('REPRO-GUIDANCE-VENDOR.json sha256 is stale; re-vendor it.');
} else {
  writeFileSync(join(dest, 'repro-guidance.ts'), text);
  writeFileSync(join(dest, 'REPRO-GUIDANCE-VENDOR.json'), manifest);
}
console.log(`Repro guidance ${mode === '--check' ? 'parity verified' : 'vendored'}: ${sha256} @ ${commit}`);
