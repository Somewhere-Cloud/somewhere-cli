import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiClient } from './client.js';
import { CliApiError } from './client.js';
import { ensureGitignored, ensurePrivateDir, stateDir, writePrivateFile } from './test-identities.js';

/** `somewhere verify --keep-actors`: what this project folder remembers between runs
 *  of one multi-user flow. Ids and emails only; never a token, cookie or password
 *  (the browsers' sessions live on the platform, owned by this developer). */
export const KEEP_FILE = 'verify-actors.json';
/** Test identities live 24 h; reuse them only well inside that. */
export const KEEP_IDENTITY_REUSE_MS = 23 * 60 * 60 * 1000;

export interface KeepEntry {
  project_id: string;
  created_at: string;
  actors: string[];
  sessions: Record<string, string>;
  identities?: Record<string, { user_id: string; email: string }>;
}
type KeepFile = Record<string, KeepEntry>;

/** Stable per project + actor set (names and how each signs in), so a changed cast starts fresh. */
export function keepKey(projectId: string, actors: Record<string, Record<string, unknown>>): string {
  const cast = Object.keys(actors).sort().map((name) => [name, actors[name].test_user === true ? 'test_user' : actors[name].auth ? 'auth' : Object.keys(actors[name]).sort().join('+') || 'signed_out']);
  return createHash('sha256').update(projectId + '\n' + JSON.stringify(cast)).digest('hex').slice(0, 12);
}

function path(root: string): string { return join(stateDir(root), KEEP_FILE); }
function readAll(root: string): KeepFile {
  if (!existsSync(path(root))) return {};
  try { const parsed = JSON.parse(readFileSync(path(root), 'utf-8')); return parsed && typeof parsed === 'object' ? parsed as KeepFile : {}; }
  catch { return {}; }
}
function writeAll(root: string, all: KeepFile): void {
  ensureGitignored(root); ensurePrivateDir(stateDir(root));
  writePrivateFile(path(root), JSON.stringify(all, null, 2) + '\n');
}

export function readKeep(root: string, key: string): KeepEntry | null { return readAll(root)[key] ?? null; }
export function writeKeep(root: string, key: string, entry: KeepEntry): void { writeAll(root, { ...readAll(root), [key]: entry }); }
export function dropKeep(root: string, key: string): void {
  const all = readAll(root); if (!(key in all)) return; delete all[key]; writeAll(root, all);
}
/** Identities a previous keeping run left, if still well inside their lifetime. */
export function reusableIdentities(entry: KeepEntry | null, now: number): KeepEntry['identities'] | undefined {
  if (!entry?.identities) return undefined;
  const at = Date.parse(entry.created_at);
  return Number.isFinite(at) && now - at < KEEP_IDENTITY_REUSE_MS ? entry.identities : undefined;
}

/** --close-actors: close each kept browser and delete the kept test identities. */
export async function closeKept(client: Pick<ApiClient, 'call'>, entry: KeepEntry): Promise<{ browsers: Array<{ actor: string; status: string }>; identities: { status: string; deleted?: number } }> {
  const browsers = await Promise.all(Object.entries(entry.sessions).map(async ([actor, session_id]) => {
    try {
      const result = await client.call<{ closed?: boolean }>('POST', '/browser/test', { project_id: entry.project_id, session_id, close: true });
      return { actor, status: result?.closed === true ? 'closed' : 'already_closed' };
    } catch (cause) {
      return { actor, status: `unconfirmed (${cause instanceof CliApiError ? cause.code : cause instanceof Error ? cause.message : String(cause)})` };
    }
  }));
  const ids = Object.values(entry.identities ?? {}).map((item) => item.user_id);
  if (!ids.length) return { browsers, identities: { status: 'none' } };
  try {
    const removed = await client.call<{ deleted?: number }>('DELETE', '/auth/test-users', { project_id: entry.project_id, ids });
    return { browsers, identities: { status: 'deleted', ...(typeof removed?.deleted === 'number' ? { deleted: removed.deleted } : {}) } };
  } catch (cause) {
    return { browsers, identities: { status: `unconfirmed (${cause instanceof CliApiError ? cause.code : 'delete failed'}); they expire 24 hours after creation` } };
  }
}
