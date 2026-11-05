// The somewhere-tech commit the runtime bundles were vendored from (tsk_d7b75ca6).
// vendor-declared-data.mjs and vendor-source-lint.mjs record it when they write;
// test/vendor-platform-source.test.mjs re-vendors that commit with --check, so a
// CLI cannot be published with bundles that differ from the source they name.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PLATFORM_REPOSITORY = 'Somewhere-Cloud/somewhere-tech';
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

export function writePlatformSource(cliRoot, commit) {
  writeFileSync(join(cliRoot, PLATFORM_SOURCE_FILE), JSON.stringify({ repository: PLATFORM_REPOSITORY, commit }, null, 2) + '\n');
}
