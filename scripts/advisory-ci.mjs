// tsk_315d94e3: trusted workflow helper, kept outside the published-source checkout.
import { appendFileSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCandidate } from './publish-release.mjs';
import { readPublishedVersion } from './version-guard.mjs';

export const OFFICIAL = 'Somewhere-Cloud/somewhere-cli';
const NAME = '@somewhere-tech/cli';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
export function validateTrigger(env) {
  if (env.GITHUB_REPOSITORY !== OFFICIAL || env.GITHUB_REF !== 'refs/heads/master' ||
      !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) throw new Error('untrusted advisory trigger');
  validateCandidate(env.GITHUB_SHA, '0.0.0');
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    if (typeof env.REGRESSION_REASON !== 'string' || !env.REGRESSION_REASON.trim() || env.REGRESSION_REASON.length > 500 ||
        /[\x00-\x1f\x7f]/.test(env.REGRESSION_REASON)) throw new Error('manual reason required');
    parseSelection(env.REGRESSION_TESTS);
  }
}
export function parseSelection(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('explicit regression files required');
  const files = value.trim().split(/\s+/);
  if (files.length > 100 || new Set(files).size !== files.length ||
      files.some((f) => !/^test\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/.test(f))) throw new Error('invalid regression selection');
  return files;
}
export function validateManifest(value) {
  if (!value || value.name !== NAME || value.repository?.type !== 'git' ||
      value.repository.url !== `git+https://github.com/${OFFICIAL}.git`) throw new Error('untrusted registry repository');
  validateCandidate(value.gitHead, value.version);
  return { source: value.gitHead, version: value.version };
}
export async function resolvePublished(fetcher = fetch) {
  const fixedFetch = (url, options) => fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const r = await fixedFetch('https://registry.npmjs.org/@somewhere-tech%2Fcli/latest');
  if (!r.ok) throw new Error('latest registry identity unavailable');
  const latest = validateManifest(await r.json());
  const exact = validateManifest(await readPublishedVersion(NAME, latest.version, fixedFetch));
  if (exact.source !== latest.source || exact.version !== latest.version) throw new Error('exact registry identity disagrees');
  return latest; // Never read latest again during this batch.
}
export function assertAncestry(source, master, cwd) {
  validateCandidate(source, '0.0.0'); validateCandidate(master, '0.0.0');
  const r = spawnSync('git', ['merge-base', '--is-ancestor', source, master], { cwd });
  if (r.status !== 0) throw new Error('published source is not captured official master ancestry');
}
export function assertCheckout(pin, cwd) {
  validateCandidate(pin.source, pin.version);
  const p = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  if (git(cwd, 'rev-parse', 'HEAD') !== pin.source || p.name !== NAME || p.version !== pin.version) throw new Error('published checkout mismatch');
}
export function testArguments(shard, selection, roster) {
  if (shard === 'manual') {
    const files = parseSelection(selection);
    if (files.some((f) => !roster.includes(f))) throw new Error('regression file is not in published test roster');
    return ['--test', '--test-concurrency=1', ...files];
  }
  if (!['1/2', '2/2'].includes(shard)) throw new Error('invalid native shard');
  if (!roster.length) throw new Error('empty published test roster');
  return ['--test', '--test-concurrency=1', `--test-shard=${shard}`, ...roster];
}
function roster(cwd) {
  return readdirSync(resolve(cwd, 'test')).filter((f) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/.test(f))
    .map((f) => `test/${f}`).sort().filter((f) => {
      const stat = lstatSync(resolve(cwd, f));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('nonregular published test file');
      return true;
    });
}
async function main() {
  const [phase, directory] = process.argv.slice(2); const cwd = resolve(directory ?? '.');
  validateTrigger(process.env);
  if (phase === 'resolve') {
    if (git(cwd, 'rev-parse', 'HEAD') !== process.env.GITHUB_SHA ||
        git(cwd, 'remote', 'get-url', 'origin') !== `https://github.com/${OFFICIAL}` &&
        git(cwd, 'remote', 'get-url', 'origin') !== `https://github.com/${OFFICIAL}.git`) throw new Error('workflow checkout is not official source');
    const pin = await resolvePublished();
    assertAncestry(pin.source, process.env.GITHUB_SHA, cwd);
    const matrix = process.env.GITHUB_EVENT_NAME === 'schedule' ? ['1/2', '2/2'] : ['manual'];
    appendFileSync(process.env.GITHUB_OUTPUT, `source=${pin.source}\nversion=${pin.version}\nshards=${JSON.stringify(matrix)}\n`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Published CLI ${pin.version}, source ${pin.source}; captured master ${process.env.GITHUB_SHA}; observed ${new Date().toISOString()}. Advisory batch, not a publication gate.\n`);
  } else if (phase === 'verify' || phase === 'run') {
    const pin = { source: process.env.PUBLISHED_SOURCE, version: process.env.PUBLISHED_VERSION };
    assertCheckout(pin, cwd);
    const argv = testArguments(process.env.CI_SHARD, process.env.REGRESSION_TESTS, roster(cwd));
    if (phase === 'verify') return;
    const started = Date.now();
    const child = spawnSync(process.execPath, argv, { cwd, env: process.env, stdio: 'inherit' });
    const status = Number.isInteger(child.status) ? child.status : 1;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `CLI ${pin.version} (${pin.source}), shard ${process.env.CI_SHARD}: exit ${status}, elapsed ${Date.now() - started}ms.\n`);
    process.exitCode = status;
  } else throw new Error('unknown advisory phase');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
