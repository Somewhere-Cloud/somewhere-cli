/**
 * The preview tool credential: a separate, revocable credential for ONE open preview, minted by
 * the platform when this CLI opens or continues that preview (under your own sign-in, as a
 * developer operation), and dead when the preview closes, is promoted or expires.
 *
 * It acts only on that preview's users, test users and captured mail. Preview tool commands send
 * this credential and nothing else: they never fall back to your own sign-in, and the platform
 * refuses your sign-in on those routes and this credential everywhere else.
 *
 * Stored owner-only under the CLI config directory (previews/<project>__<preview>.json), never in
 * the project folder, so it stays out of source uploads and Git, and is never printed.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ApiClient, CliApiError } from './client.js';
import { cliConfigDir, writePrivateConfigFile } from './config.js';

const SUBDIR = 'previews';
const fileName = (projectId: string, previewSessionId: string) => `${projectId}__${previewSessionId}.json`;

interface StoredPreviewCredential {
  credential: string;
  project_id: string;
  preview_session_id: string;
  minted_at: string;
}

export function loadPreviewCredential(projectId: string, previewSessionId: string): string | null {
  const path = join(cliConfigDir(), SUBDIR, fileName(projectId, previewSessionId));
  if (!existsSync(path)) return null;
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredPreviewCredential;
    return stored.project_id === projectId && stored.preview_session_id === previewSessionId && typeof stored.credential === 'string'
      ? stored.credential : null;
  } catch {
    return null;
  }
}

export function forgetPreviewCredential(projectId: string, previewSessionId: string): void {
  const path = join(cliConfigDir(), SUBDIR, fileName(projectId, previewSessionId));
  if (existsSync(path)) unlinkSync(path);
}

/** Mint a fresh credential for this preview under the caller's own sign-in and store it privately. */
export async function mintPreviewCredential(client: ApiClient, projectId: string, previewSessionId: string): Promise<string> {
  const minted = await client.call<{ credential?: string }>(
    'POST', `/projects/${encodeURIComponent(projectId)}/preview/tool-credential`, { preview_session_id: previewSessionId },
  );
  if (!minted || typeof minted.credential !== 'string' || !minted.credential.startsWith('swpt.')) {
    throw new Error('The platform did not return a preview credential.');
  }
  const stored: StoredPreviewCredential = { credential: minted.credential, project_id: projectId, preview_session_id: previewSessionId, minted_at: new Date().toISOString() };
  writePrivateConfigFile(SUBDIR, fileName(projectId, previewSessionId), JSON.stringify(stored, null, 2) + '\n');
  return minted.credential;
}

/** A client that carries ONLY the preview credential: no stored-login refresh, no fallback. */
export function previewToolClient(credential: string): { call<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> } {
  const client = new ApiClient(credential);
  return { call: <T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>) => client.call<T>(method, path, body, query, { refresh: false }) };
}

/** True when the platform refused the credential itself (closed, promoted, expired or revoked preview). */
export function isDeadPreviewCredential(err: unknown): boolean {
  return err instanceof CliApiError && (err.code === 'PREVIEW_CREDENTIAL_INVALID' || err.code === 'PREVIEW_CREDENTIAL_REQUIRED');
}
