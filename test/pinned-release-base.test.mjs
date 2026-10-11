import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('CLI never substitutes the current release into an unanchored request', () => {
  assert.equal(
    existsSync(new URL('../src/lib/pinned-release-retry.ts', import.meta.url)),
    false,
    'the hidden base-release retry helper must be absent',
  );

  const deploySource = readFileSync(new URL('../src/commands/deploy.ts', import.meta.url), 'utf8');
  const devSource = readFileSync(new URL('../src/commands/dev.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(deploySource, /pinnedReleaseRetryBody|BASE_RELEASE_REQUIRED/);
  assert.match(deploySource, /client\.call<T>\('POST', '\/deploy', body/);
  assert.doesNotMatch(devSource, /callWithPinnedReleaseRetry/);
  assert.match(devSource, /callDraftCandidate<DeployResult>\(client, '\/deploy', body(?:,|\))/);
  assert.match(devSource, /callDraftCandidate<PatchResult>\(client, '\/deploy\/patch', body\)/);
  assert.match(devSource, /preview_operation_id: firstOperationId/);
  assert.match(devSource, /expected_preview_id: null/);
  assert.match(devSource, /expected_preview_id: expectedCandidateReleaseId/);
  // The preview retains the folder's recorded base even if live has moved.
  assert.match(devSource, /sourceBase: readSourceBase\(loadProjectConfig\(cwd\), projectId\)/);
  assert.match(devSource, /saveSourceBase\(cwd, projectId, releaseId\)/);
  assert.match(devSource, /base_release_id: null/);
  assert.match(devSource, /base_release_id: baseReleaseId/);
  assert.doesNotMatch(devSource, /current_release/);
  assert.match(devSource, /initialAutoOpenUrl = \(await mintPreviewHandoff\([\s\S]*initialHandoff = await mintPreviewHandoff/);
  assert.match(devSource, /const handoff = await mintPreviewHandoff\(client, projectId, draftId, nextCandidate\);[\s\S]*printPreviewHandoff\(handoff\)/);
});
