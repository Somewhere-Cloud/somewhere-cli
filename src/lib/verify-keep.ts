import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiClient } from './client.js';
import { CliApiError } from './client.js';
import { ensureGitignored, ensurePrivateDir, stateDir, writePrivateFile } from './test-identities.js';

/** `somewhere verify --keep-actors`: what THIS project folder remembers between runs
 *  of one multi-user flow. Ids, emails and session names only; never a token, cookie
 *  or password (the browsers' sessions live on the platform, owned by this developer). */
export const KEEP_FILE = 'verify-actors.json';
/** Test identities live 24 h; reuse them only well inside that. */
export const KEEP_IDENTITY_REUSE_MS = 23 * 60 * 60 * 1000;
/** A run's lock older than this is stale even if its process id was reused. */
export const KEEP_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export interface KeepEntry {
  project_id: string;
  created_at: string;
  actors: string[];
  sessions: Record<string, string>;
  identities?: Record<string, { user_id: string; email: string }>;
}
interface KeepFile { salt?: string; entries?: Record<string, KeepEntry> }

function path(root: string): string { return join(stateDir(root), KEEP_FILE); }
function readFile(root: string): KeepFile {
  if (!existsSync(path(root))) return {};
  try { const parsed = JSON.parse(readFileSync(path(root), 'utf-8')); return parsed && typeof parsed === 'object' ? parsed as KeepFile : {}; }
  catch { return {}; }
}
function writeFile(root: string, file: KeepFile): void {
  ensureGitignored(root); ensurePrivateDir(stateDir(root));
  writePrivateFile(path(root), JSON.stringify(file, null, 2) + '\n');
}
/** A random per-folder salt, so two folders linked to one project never share kept browsers. */
export function folderSalt(root: string): string {
  const file = readFile(root);
  if (typeof file.salt === 'string' && /^[0-9a-f]{16,}$/.test(file.salt)) return file.salt;
  const salt = randomBytes(12).toString('hex');
  writeFile(root, { ...file, salt });
  return salt;
}

/** Stable per folder, project, flow file and full cast (names, sign-in and seed values,
 *  hashed only), so a different flow, user or seed never reconnects to these browsers. */
export function keepKey(salt: string, projectId: string, flowPath: string, actors: Record<string, unknown>): string {
  const cast = Object.keys(actors).sort().map((name) => [name, canonical(actors[name])]);
  return createHash('sha256').update([salt, projectId, flowPath, JSON.stringify(cast)].join('\n')).digest('hex').slice(0, 12);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  return value;
}

export function readKeep(root: string, key: string): KeepEntry | null { return readFile(root).entries?.[key] ?? null; }
export function listKeep(root: string, projectId: string): Array<[string, KeepEntry]> {
  return Object.entries(readFile(root).entries ?? {}).filter(([, entry]) => entry.project_id === projectId);
}
export function writeKeep(root: string, key: string, entry: KeepEntry): void {
  const file = readFile(root); writeFile(root, { ...file, entries: { ...(file.entries ?? {}), [key]: entry } });
}
export function dropKeep(root: string, key: string): void {
  const file = readFile(root); if (!file.entries || !(key in file.entries)) return;
  delete file.entries[key]; writeFile(root, file);
}
/** Identities a previous keeping run left, if still well inside their lifetime. */
export function reusableIdentities(entry: KeepEntry | null, now: number): KeepEntry['identities'] | undefined {
  if (!entry?.identities) return undefined;
  const at = Date.parse(entry.created_at);
  return Number.isFinite(at) && now - at < KEEP_IDENTITY_REUSE_MS ? entry.identities : undefined;
}

/** One run per kept flow at a time: an exclusive lock file for the whole run. A
 *  lock whose process is gone, or older than KEEP_LOCK_STALE_MS, is taken over. */
export function lockKeep(root: string, key: string, now = Date.now()): () => void {
  ensurePrivateDir(stateDir(root));
  const lock = join(stateDir(root), `verify-actors-${key}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: now }));
      closeSync(fd);
      return () => { try { rmSync(lock, { force: true }); } catch { /* best effort */ } };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      let stale = true;
      try {
        const held = JSON.parse(readFileSync(lock, 'utf-8')) as { pid?: number; at?: number };
        const alive = typeof held.pid === 'number' && (() => { try { process.kill(held.pid, 0); return true; } catch { return false; } })();
        stale = !alive || now - (held.at ?? statSync(lock).mtimeMs) > KEEP_LOCK_STALE_MS;
      } catch { stale = true; }
      if (!stale) throw Object.assign(new Error('Another --keep-actors run of this flow is in progress in this project folder; wait for it to finish (one run per kept flow at a time).'), { code: 'VERIFY_KEEP_BUSY' });
      rmSync(lock, { force: true });
    }
  }
  throw Object.assign(new Error('Could not take the --keep-actors lock for this flow.'), { code: 'VERIFY_KEEP_BUSY' });
}

/** What the record should say after a run: keep (what this run kept), keep the old
 *  record (cleanup unconfirmed, so --close-actors can still find it), or drop it. */
export function recordAfterRun(
  previous: KeepEntry | null,
  report: { keep_actors?: { kept: string[]; reused_identities: boolean }; kept_sessions: Array<{ actor: string; session_id: string }>; cleanup: Array<{ status: string }>; test_users?: { identities: Array<{ actor: string; user_id: string; email: string }>; cleanup: { status: string } } },
  projectId: string, now: number,
): { action: 'write'; entry: KeepEntry } | { action: 'keep' } | { action: 'drop' } {
  const kept = report.keep_actors?.kept ?? [];
  if (kept.length) {
    const identities = report.test_users?.cleanup.status === 'kept'
      ? Object.fromEntries(report.test_users.identities.map((item) => [item.actor, { user_id: item.user_id, email: item.email }]))
      : undefined;
    return { action: 'write', entry: {
      project_id: projectId,
      created_at: report.keep_actors?.reused_identities && previous ? previous.created_at : new Date(now).toISOString(),
      actors: kept,
      sessions: Object.fromEntries(report.kept_sessions.filter((item) => kept.includes(item.actor)).map((item) => [item.actor, item.session_id])),
      ...(identities ? { identities } : {}),
    } };
  }
  const unconfirmed = report.cleanup.some((item) => item.status === 'unconfirmed')
    || (report.test_users !== undefined && report.test_users.cleanup.status !== 'deleted');
  if (!previous || !unconfirmed) return { action: 'drop' };
  // Keep the record so --close-actors can find what may still be alive, but never
  // hand a later run identities this run already deleted.
  if (report.test_users?.cleanup.status === 'deleted' && previous.identities) {
    const { identities: _deleted, ...rest } = previous;
    return { action: 'write', entry: rest };
  }
  return { action: 'keep' };
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

/** The one line --keep-actors prints on stderr when this run cannot reconnect:
 *  nothing is kept for THIS flow file and cast in this folder (a new or renamed
 *  flow file, or a changed cast, starts fresh). Null when there is a record. */
export function keepStartNote(entry: KeepEntry | null, otherFlowsKept: number): string | null {
  if (entry) return null;
  const others = otherFlowsKept > 0
    ? ` ${otherFlowsKept} other kept flow${otherFlowsKept === 1 ? '' : 's'} in this folder (another flow file path or cast) ${otherFlowsKept === 1 ? 'is' : 'are'} not reused; --close-actors closes ${otherFlowsKept === 1 ? 'it' : 'them'}.`
    : '';
  return `--keep-actors: nothing is kept yet for this flow file and its actors in this folder, so this run starts fresh and keeps them for the next run of the same file.${others}`;
}
