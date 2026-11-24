import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PLATFORM_SOURCE_FILE = 'runtime/PLATFORM-SOURCE.json';

/** HEAD of the platform checkout; refuses when any vendored input differs from it. */
export function platformCommit(root, inputs) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  const tracked = inputs.filter(path => !path.split('/').includes('node_modules'));
  const dirty = git('status', '--porcelain', '--', ...tracked);
  if (dirty) throw new Error(`Vendor from a clean platform checkout: these inputs differ from ${commit}:\n${dirty}`);
  return commit;
}

export function writePlatformSource(cliRoot) {
  const files = ['declared-data.cjs', 'source-lint.cjs'];
  const sha256 = createHash('sha256');
  for (const file of files) sha256.update(file + '\0').update(readFileSync(join(cliRoot, 'runtime', file)));
  writeFileSync(join(cliRoot, PLATFORM_SOURCE_FILE), JSON.stringify({ sha256: sha256.digest('hex') }, null, 2) + '\n');
}

/** Verify the generated checker bytes against their vendored source manifest. */
export function verifyDeclaredDataVendor(cliRoot) {
  const runtime = join(cliRoot, 'runtime');
  const { source_commit: sourceCommit, sha256 } = JSON.parse(readFileSync(join(runtime, 'DECLARED-DATA-VENDOR.json'), 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('The generated checker needs a pinned platform source commit.');
  const actual = createHash('sha256').update(readFileSync(join(runtime, 'declared-data.cjs'))).digest('hex');
  if (actual !== sha256) throw new Error('The generated checker differs from its source manifest. Run scripts/vendor-declared-data.mjs.');
}
