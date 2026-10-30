#!/usr/bin/env node
// Vendor (or prove byte parity with) the platform's deploy path policy, worker/src/utils/deploy-paths.ts:
// the rule the deploy API applies to every uploaded path. The copy is byte-identical, read from a commit
// (not a working tree), so its sha256 is that commit's file; the manifest pins the commit.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const sourceRoot = args.find((arg) => !arg.startsWith('--'));
const check = args.includes('--check');
const rev = args.find((arg) => arg.startsWith('--rev='))?.slice('--rev='.length) ?? 'HEAD';
if (!sourceRoot || args.some((arg) => arg.startsWith('--') && arg !== '--check' && !arg.startsWith('--rev='))) {
  throw new Error('Usage: node scripts/vendor-deploy-paths.mjs <platform-source> [--rev=<commit>] [--check]');
}
const root = resolve(sourceRoot);
const SOURCE = 'worker/src/utils/deploy-paths.ts';
const commit = execFileSync('git', ['-C', root, 'rev-parse', `${rev}^{commit}`], { encoding: 'utf8' }).trim();
const text = execFileSync('git', ['-C', root, 'show', `${commit}:${SOURCE}`], { encoding: 'utf8' });
const sha256 = createHash('sha256').update(text).digest('hex');
const dest = join(import.meta.dirname, '..', 'src/lib/vendor');
if (check) {
  if (readFileSync(join(dest, 'deploy-paths.ts'), 'utf8') !== text) throw new Error(`src/lib/vendor/deploy-paths.ts differs from ${SOURCE} at ${commit}; re-vendor it.`);
  const pinned = JSON.parse(readFileSync(join(dest, 'DEPLOY-PATHS-VENDOR.json'), 'utf8'));
  if (pinned.sha256 !== sha256) throw new Error('DEPLOY-PATHS-VENDOR.json sha256 is stale; re-vendor it.');
} else {
  writeFileSync(join(dest, 'deploy-paths.ts'), text);
  writeFileSync(join(dest, 'DEPLOY-PATHS-VENDOR.json'), JSON.stringify({ source: SOURCE, commit, sha256 }, null, 2) + '\n');
}
console.log(`Deploy path policy ${check ? 'parity verified' : 'vendored'}: ${sha256} @ ${commit}`);
