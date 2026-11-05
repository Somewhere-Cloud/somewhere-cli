// The runtime bundles are exactly a fresh vendor of the platform commit they
// name (tsk_d7b75ca6). 0.38.16 shipped a schema parser that predated grant(),
// so `somewhere typecheck` refused a form deploy accepted. This test exports
// runtime/PLATFORM-SOURCE.json's commit from a somewhere-tech checkout and runs
// both vendor scripts with --check against it. It never skips: without a
// checkout holding that commit it fails and says how to provide one.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PLATFORM_REPOSITORY, PLATFORM_SOURCE_FILE } from '../scripts/platform-source.mjs';

const cliRoot = join(import.meta.dirname, '..');
// What the vendor scripts read: the bundled sources, their package pins and the lint fixtures.
const EXPORTED = ['shared', 'worker/src', 'worker/containers/compile', 'worker/package.json', 'worker/tsconfig.json', 'worker/verify/fixtures/source-lint.json'];
const DEPENDENCIES = ['worker/node_modules', 'worker/containers/compile/node_modules'];

function hasCommit(repo, commit) {
  return existsSync(repo) && spawnSync('git', ['-C', repo, 'cat-file', '-e', `${commit}^{commit}`]).status === 0;
}

test('runtime bundles are a fresh vendor of the platform commit they name', () => {
  const source = JSON.parse(readFileSync(join(cliRoot, PLATFORM_SOURCE_FILE), 'utf8'));
  assert.equal(source.repository, PLATFORM_REPOSITORY);
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  const candidates = [process.env.SOMEWHERE_TECH_REPO, resolve(cliRoot, '../tech'), join(homedir(), 'somewhere/tech')].filter(Boolean);
  const tech = candidates.find(repo => hasCommit(repo, source.commit));
  assert.ok(tech, `No ${PLATFORM_REPOSITORY} checkout holds ${source.commit} (looked in ${candidates.join(', ')}). `
    + `Set SOMEWHERE_TECH_REPO to a checkout and run: git -C <checkout> fetch origin ${source.commit}`);
  for (const dir of DEPENDENCIES) {
    assert.ok(existsSync(join(tech, dir)), `${join(tech, dir)} is missing; run npm ci there (the vendor scripts use its pinned esbuild).`);
  }
  const root = mkdtempSync(join(tmpdir(), 'cli-platform-source-'));
  try {
    const paths = EXPORTED.filter(path => spawnSync('git', ['-C', tech, 'cat-file', '-e', `${source.commit}:${path}`]).status === 0);
    const tarball = execFileSync('git', ['-C', tech, 'archive', '--format=tar', source.commit, '--', ...paths], { maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', root], { input: tarball });
    for (const dir of DEPENDENCIES) {
      mkdirSync(join(root, dir, '..'), { recursive: true });
      symlinkSync(join(tech, dir), join(root, dir), 'dir');
    }
    for (const script of ['vendor-declared-data.mjs', 'vendor-source-lint.mjs']) {
      const run = spawnSync(process.execPath, [join(cliRoot, 'scripts', script), root, '--check'], { encoding: 'utf8' });
      const output = `${run.stderr}\n${run.stdout}`;
      const reason = output.match(/^\w*Error: .*$/m)?.[0] ?? output.trim().split('\n').at(-1);
      assert.equal(run.status, 0, `${script} --check against ${PLATFORM_REPOSITORY}@${source.commit}: ${reason}\n`
        + `Re-vendor from a clean checkout at the platform commit you want: node scripts/${script} <tech>.`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
