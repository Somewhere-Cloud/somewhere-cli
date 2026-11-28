import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { ApiClient, CliApiError, LONG_CALL_TIMEOUT_MS } from './client.js';

const PARALLEL_UPLOADS = 32;

export async function uploadDeployBlobs(
  client: ApiClient,
  dir: string,
  projectId: string,
  paths: Map<string, number>,
  hashes: Record<string, string>,
): Promise<{ blobFiles: Record<string, string>; checkMs: number; uploadMs: number }> {
  const files = new Map<string, { sha256: string; size: number; path: string }>();
  for (const [path, size] of paths) {
    const sha256 = hashes[path];
    files.set(sha256, { sha256, size, path });
  }
  process.stderr.write(`Checking ${paths.size} static files...\n`);
  const checkStarted = performance.now();
  const { missing } = await client.call<{ missing: string[] }>('POST', '/deploy/blobs/check', {
    project_id: projectId,
    files: [...files.values()].map(({ sha256, size }) => ({ sha256, size })),
  }, undefined, { timeoutMs: LONG_CALL_TIMEOUT_MS });
  const checkMs = performance.now() - checkStarted;
  process.stderr.write(`Uploading ${missing.length} of ${files.size} distinct static files.\n`);

  const uploadStarted = performance.now();
  let next = 0;
  let failure: unknown;
  const query = new URLSearchParams({ project_id: projectId });
  await Promise.all(Array.from({ length: Math.min(missing.length, PARALLEL_UPLOADS) }, async () => {
    while (next < missing.length && !failure) {
      const file = files.get(missing[next++]);
      if (!file) throw new Error('The deploy returned an unknown file hash.');
      try {
        const response = await client.callStream('PUT', `/deploy/blobs/${file.sha256}?${query}`,
          () => createReadStream(join(dir, file.path)), {
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) },
            replayableBody: true,
            timeoutMs: LONG_CALL_TIMEOUT_MS,
          });
        const answer = await response.json().catch(() => null) as { ok?: boolean; error?: string; message?: string } | null;
        if (!response.ok || answer?.ok !== true) {
          throw new CliApiError(answer?.error ?? 'BLOB_UPLOAD_FAILED', answer?.message ?? `Upload returned HTTP ${response.status}.`, response.status);
        }
      } catch (cause) {
        failure ??= new CliApiError(
          cause instanceof CliApiError ? cause.code : 'BLOB_UPLOAD_FAILED',
          `Could not upload "${file.path}". ${cause instanceof Error ? cause.message : String(cause)}`,
          cause instanceof CliApiError ? cause.statusCode : 0,
        );
      }
    }
  }));
  if (failure) throw failure;
  const uploadMs = performance.now() - uploadStarted;
  const blobFiles = Object.fromEntries([...paths.keys()].map(path => [path, `sha256:${hashes[path]}`]));
  return { blobFiles, checkMs, uploadMs };
}
