import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyPublishedProvenance } from '../dist/lib/update-security.js';

// Public npm receipts for the previous package name (@somewhere-tech/cli),
// captured 2026-09-29. They are genuine and still verify cryptographically, but
// their signed identity is not @somewhere-cloud/cli from Somewhere-Cloud/somewhere-cli, so the pinned policy
// refuses them.
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/npm-provenance/${name}.json`, import.meta.url), 'utf8'));
const slsa = (body) => body.attestations.find((entry) => entry.predicateType === 'https://slsa.dev/provenance/v1').bundle;

for (const name of ['official-v02', 'official-v03']) {
  const { release, provenance } = fixture(name);
  test(`${name}: a genuine receipt for the previous package identity is refused`, async () => {
    await assert.rejects(verifyPublishedProvenance(provenance, release), /(?:cryptographic npm provenance verification failed|signed provenance does not match)/);
  });
  test(`${name}: signature and signed-source tampering are refused`, async () => {
    const signature = structuredClone(provenance);
    slsa(signature).dsseEnvelope.signatures[0].sig = Buffer.from('forged').toString('base64');
    await assert.rejects(verifyPublishedProvenance(signature, release), /cryptographic npm provenance verification failed/);
    const source = structuredClone(provenance);
    const envelope = slsa(source).dsseEnvelope;
    const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
    statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = '0'.repeat(40);
    envelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
    await assert.rejects(verifyPublishedProvenance(source, release), /cryptographic npm provenance verification failed/);
  });
  test(`${name}: wrong registry digest and package identity are refused`, async () => {
    await assert.rejects(verifyPublishedProvenance(provenance, { ...release, integrity: `sha512-${Buffer.alloc(64).toString('base64')}` }), /(?:cryptographic npm provenance verification failed|signed provenance does not match)/);
    await assert.rejects(verifyPublishedProvenance(provenance, { ...release, version: '99.99.99' }), /(?:cryptographic npm provenance verification failed|signed provenance does not match)/);
  });
  test(`${name}: unknown format, missing transparency proof and certificate are refused`, async () => {
    const unknown = structuredClone(provenance);
    slsa(unknown).mediaType = 'application/vnd.dev.sigstore.bundle.v0.99+json';
    await assert.rejects(verifyPublishedProvenance(unknown, release), /no signed Sigstore provenance bundle/);
    const noProof = structuredClone(provenance);
    slsa(noProof).verificationMaterial.tlogEntries = [];
    await assert.rejects(verifyPublishedProvenance(noProof, release), /no signed Sigstore provenance bundle/);
    const noCertificate = structuredClone(provenance);
    delete slsa(noCertificate).verificationMaterial.certificate;
    delete slsa(noCertificate).verificationMaterial.x509CertificateChain;
    await assert.rejects(verifyPublishedProvenance(noCertificate, release), /cryptographic npm provenance verification failed/);
  });
}

test('a real signed v0.3 receipt from another publisher fails pinned GitHub identity', async () => {
  const other = fixture('other-publisher-v03');
  const official = fixture('official-v03');
  await assert.rejects(verifyPublishedProvenance(other.provenance, official.release), /cryptographic npm provenance verification failed/);
});
