import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { RELEASE_INPUTS, inspectVersion, readPublishedVersion } from './version-guard.mjs';

const packageName = '@somewhere-cloud/cli';
const registry = 'https://registry.npmjs.org';

export function validateCandidate(source, version) {
  if (!/^[0-9a-f]{40}(?![\s\S])/.test(source ?? '')) throw new Error('source must be an exact lowercase 40-hex commit');
  // Canonical SemVer, without a leading v or leading numeric zeroes.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/.test(version ?? '')) {
    throw new Error('expected version must be canonical SemVer');
  }
}

export function assertCandidateIdentity(source, head, master) {
  if (head !== source || master !== source) throw new Error('candidate is no longer exact current origin/master');
}

export async function checkCandidate(source, version) {
  validateCandidate(source, version);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  if (!/^https:\/\/github\.com\/Somewhere-Cloud\/somewhere-cli(?:\.git)?$/.test(git('remote', 'get-url', 'origin'))) {
    throw new Error('unexpected origin repository');
  }
  git('fetch', '--no-tags', 'origin', '+refs/heads/master:refs/remotes/origin/master');
  assertCandidateIdentity(source, git('rev-parse', 'HEAD'), git('rev-parse', 'origin/master'));
  git('diff', '--exit-code', 'HEAD', '--', ...RELEASE_INPUTS);
  const state = await inspectVersion(process.cwd(), version);
  if (state.mode === 'drift') throw new Error('published version has different guarded release inputs');
  console.log(JSON.stringify({ ...state, publication: state.mode === 'in-sync' ? 'already-published-no-op' : 'candidate' })); // In-sync descendants retain the actual registry gitHead.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${state.mode}\npublished_head=${state.publishedHead ?? source}\n`);
  return state;
}

export function assertProvenanceSource(body, source) {
  const attestation = body.attestations?.find((entry) => entry.predicateType === 'https://slsa.dev/provenance/v1');
  const statement = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const sources = statement.predicate?.buildDefinition?.resolvedDependencies?.filter((entry) =>
    entry.uri?.startsWith('git+https://github.com/Somewhere-Cloud/somewhere-cli@'));
  if (!sources?.length || sources.some((entry) => entry.digest?.gitCommit !== source)) {
    throw new Error('verified provenance does not authenticate the registry gitHead');
  }
}

export async function pollVerification(verify, pause = sleep) {
  const propagationWindowMs = 120 * 60_000;
  let delayMs = 60_000;
  let waitedMs = 0;
  for (;;) {
    try {
      return await verify();
    } catch (error) {
      if (waitedMs === propagationWindowMs) {
        throw new Error(`publication state unknown; read verification exhausted; do not retry publication: ${error.message}`);
      }
    }
    const nextWaitMs = Math.min(delayMs, propagationWindowMs - waitedMs);
    await pause(nextWaitMs);
    waitedMs += nextWaitMs;
    delayMs = Math.min(delayMs * 2, 10 * 60_000);
  }
}

export async function readPropagatedRelease(source, version, fetcher = fetch) {
  const manifest = await readExactRelease(source, version, fetcher);
  const latestResponse = await fetcher(`${registry}/${encodeURIComponent(packageName)}/latest`, { signal: AbortSignal.timeout(15_000) });
  if (!latestResponse.ok) throw new Error(`npm latest lookup failed: HTTP ${latestResponse.status}`);
  const latest = await latestResponse.json();
  if (latest.version !== version) throw new Error(`npm latest is ${latest.version ?? 'missing'}, expected ${version}`);
  return manifest;
}

async function readExactRelease(source, version, fetcher) {
  const manifest = await readPublishedVersion(packageName, version, fetcher);
  if (!manifest || manifest.gitHead !== source) throw new Error('registry source identity mismatch or pending publication');
  return manifest;
}

async function getRegistry(url, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (response.status !== 200) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return response;
}

async function verifyReleaseArtifact(manifest, source, version, fetcher = fetch) {
  const { parseOfficialRelease, verifyTarballIntegrity, verifyPublishedProvenance } = await import('../dist/lib/update-security.js');
  const release = parseOfficialRelease({ 'dist-tags': { latest: version }, versions: { [version]: manifest } });
  const tarball = await getRegistry(release.tarballUrl, fetcher);
  verifyTarballIntegrity(new Uint8Array(await tarball.arrayBuffer()), release.integrity);
  const provenance = await (await getRegistry(release.attestationUrl, fetcher)).json();
  await verifyPublishedProvenance(provenance, release);
  assertProvenanceSource(provenance, source);
  console.log(JSON.stringify({ verified: true, version, publishedHead: source, integrity: release.integrity }));
}

export async function pollPromotion(check, pause = sleep, now = Date.now) {
  const deadline = now() + 15 * 60_000;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new Error(`Promotion timed out after 15 minutes. Check the candidate in npm and retry promotion. Last read: ${error.message}`);
      }
      await pause(Math.min(15_000, remaining));
    }
  }
}

export async function readPromotionCandidate(source, version, fetcher = fetch, verifyArtifact = verifyReleaseArtifact) {
  const tags = await (await getRegistry(`${registry}/-/package/${encodeURIComponent(packageName)}/dist-tags`, fetcher)).json();
  if (tags.latest === version) return null;
  if (!tags.latest || tags['release-candidate'] !== version) {
    throw new Error(`npm latest or release-candidate@${version} is not visible yet (latest=${tags.latest}, release-candidate=${tags['release-candidate']})`);
  }
  const manifest = await readExactRelease(source, version, fetcher);
  await verifyArtifact(manifest, source, version, fetcher);
  return tags.latest;
}

async function promoteRelease(source, version) {
  const { default: semver } = await import('semver');
  const latest = await pollPromotion(() => readPromotionCandidate(source, version));
  if (latest === null) {
    console.log(`npm latest already points to ${packageName}@${version}.`);
    return;
  }
  if (semver.prerelease(version) || !semver.gt(version, latest)) {
    throw new Error(`Expected a stable version newer than npm latest (${latest}), got ${version}.`);
  }
  console.log(`Promoting ${packageName} from ${latest} to ${version}.`);
  execFileSync('npm', ['dist-tag', 'add', `${packageName}@${version}`, 'latest', '--registry', registry], { stdio: 'inherit' });
}

async function verifyRegistry(source, version) {
  await pollVerification(async () => {
    const manifest = await readPropagatedRelease(source, version);
    await verifyReleaseArtifact(manifest, source, version);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, source, version] = process.argv.slice(2);
  validateCandidate(source, version);
  if (phase === 'check') await checkCandidate(source, version);
  else if (phase === 'promote') await promoteRelease(source, version);
  else if (phase === 'verify') await verifyRegistry(source, version);
  else throw new Error('unknown publisher phase');
}
