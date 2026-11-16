/**
 * Accounts that `somewhere test` signs up through an app's own form (signUp fixture).
 *
 * These are ordinary app accounts made through the public door, exactly as a visitor makes them:
 * unverified at first, with a password, and no managed test-identity marking or 24 h expiry.
 * Their addresses are at reserved documentation domains, which can never receive mail, so the
 * platform holds their auth mail in the project's test inbox instead of sending it. A reserved
 * address grants nothing by itself.
 *
 * Cleanup is by exact account id only: an id is recorded only when this run's own sign-up
 * response (or its sign-up code step) returned it, and it is deleted with the developer delete.
 * Never by email. The run record is private (.somewhere/tests/accounts, 0700/0600) and holds the
 * project, address, id and run, never a password or code. An interrupted run leaves its records,
 * and the next `somewhere test` for the project finishes them.
 *
 * A run against a preview (`somewhere test --preview`) records its sign-ups apart, per preview
 * (.somewhere/tests/preview-accounts/<project>/<preview>), and removes them only with the preview's
 * own tool credential. A preview run never reads, finishes or deletes a production record, and a
 * production run never touches a preview record.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ApiClient } from './client.js';
import { CliApiError } from './client.js';
import { ensurePrivateDir, writePrivateFile } from './test-identities.js';

/** The part of a test control the sweep needs (lib/test-control.ts). */
export interface SweepControl { environment: 'production' | 'preview'; projectId: string; target: { previewSessionId?: string }; journalDir(root: string): string; deleteSignups(ids: string[]): Promise<SignupDeletion> }

/**
 * What one cleanup did with each listed id. The runner
 * deletes all the sign-ups it created together, with the teams only they belong to.
 * - `done`: gone (deleted now, or already gone); its record is finished.
 * - `kept`: still there, with why; the record is kept and the next run retries.
 * - `dropped`: can never be deleted (a closed preview's accounts went with it); the record is dropped.
 */
export interface SignupDeletion {
  done: string[];
  kept: Map<string, string>;
  dropped: Map<string, string>;
  teamsDeleted: { id: string; name: string }[];
}
interface DeletionAnswer {
  results: { id: string; outcome: 'deleted' | 'not_found' | 'kept' | 'refused'; code?: string; message?: string; groups?: { id: string; name: string }[] }[];
  groups_deleted?: { id: string; name: string }[];
}
const named = (teams: { id: string; name: string }[]) => teams.map((team) => `"${team.name}" (${team.id})`).join(', ');

/** Read the platform's per-id answer. */
export function readDeletionAnswer(ids: string[], answer: DeletionAnswer): SignupDeletion {
  const out: SignupDeletion = { done: [], kept: new Map(), dropped: new Map(), teamsDeleted: answer.groups_deleted ?? [] };
  const byId = new Map(answer.results.map((result) => [result.id, result]));
  for (const id of ids) {
    const result = byId.get(id);
    if (!result) out.kept.set(id, 'the platform did not answer for this account');
    else if (result.outcome === 'deleted' || result.outcome === 'not_found') out.done.push(id);
    else if (result.outcome === 'kept') {
      const teams = result.groups ?? [];
      out.kept.set(id, `it is the only owner of ${teams.length === 1 ? 'the team' : 'the teams'} ${named(teams)}, which ${teams.length === 1 ? 'has' : 'have'} members outside this run's sign-ups; the team and the account were left alone`);
    } else out.kept.set(id, `${result.code ?? 'REFUSED'}: ${(result.message ?? '').slice(0, 200)}`);
  }
  return out;
}

/** Every id kept (or, with `drop`, dropped) for one reason: the call itself failed. */
export function failedDeletion(ids: string[], why: string, drop = false): SignupDeletion {
  return { done: [], kept: drop ? new Map() : new Map(ids.map((id) => [id, why])), dropped: drop ? new Map(ids.map((id) => [id, why])) : new Map(), teamsDeleted: [] };
}

/** Merge the answers of several calls (the platform takes 50 ids at a time). */
export async function inBatches(ids: string[], call: (batch: string[]) => Promise<SignupDeletion>): Promise<SignupDeletion> {
  const out: SignupDeletion = { done: [], kept: new Map(), dropped: new Map(), teamsDeleted: [] };
  for (let i = 0; i < ids.length; i += 50) {
    const part = await call(ids.slice(i, i + 50));
    out.done.push(...part.done);
    for (const [id, why] of part.kept) out.kept.set(id, why);
    for (const [id, why] of part.dropped) out.dropped.set(id, why);
    out.teamsDeleted.push(...part.teamsDeleted);
  }
  return out;
}

/** What a failed call answered, for the record's line. */
export function describeCallError(error: unknown): string {
  return error instanceof CliApiError ? `HTTP ${error.statusCode ?? '?'} ${error.code}: ${error.message.slice(0, 200)}` : String(error).slice(0, 200);
}

export const RESERVED_DOMAINS_TEXT = 'example.com, example.org, example.net, or a name ending in .example or .test (for example staff.example)';
export const DEFAULT_SIGNUP_DOMAIN = 'example.com';
const EXACT = new Set(['example.com', 'example.org', 'example.net']);
const SUFFIX_TLDS = new Set(['example', 'test']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

function refuse(value: string, why: string): never {
  throw new Error(`signUp: "${value}" is not allowed (${why}). Test sign-ups use addresses that can never be a real mailbox: ${RESERVED_DOMAINS_TEXT}.`);
}

/** The one rule for a chosen sign-up address. ASCII only, one @, an ordinary local part, DNS
 *  labels (checked case-insensitively; the address is returned exactly as given, so a test of a
 *  case-insensitive app rule sees the case it typed), no trailing dot; the domain is exactly example.com/.org/.net, or has
 *  .example or .test as its last label with at least one label before it. Nothing is converted
 *  (no IDN mapping, no trimming): input that is not already in this form is refused. Plus
 *  addressing is a literal part of the local part, never a signal. */
export function admitReservedAddress(value: unknown): string {
  if (typeof value !== 'string') throw new Error('signUp: email must be a string.');
  if (!/^[\x21-\x7e]+$/.test(value)) refuse(value, 'only plain ASCII letters, digits and punctuation, no spaces or display names');
  const lower = value.toLowerCase();
  const parts = lower.split('@');
  if (parts.length !== 2) refuse(value, 'exactly one @');
  const [local, domain] = parts;
  if (!LOCAL.test(local) || local.includes('..')) refuse(value, 'the part before @ must be letters, digits and . _ + -, not starting or ending with punctuation');
  if (domain.endsWith('.')) refuse(value, 'no trailing dot');
  if (domain.length > 253) refuse(value, 'domain too long');
  const labels = domain.split('.');
  if (labels.some((label) => !LABEL.test(label))) refuse(value, 'the domain must be dot-separated letters, digits and -');
  const tld = labels[labels.length - 1];
  if (!EXACT.has(domain) && !(labels.length >= 2 && SUFFIX_TLDS.has(tld))) refuse(value, 'not a reserved domain');
  return value;
}

/** A fresh address at `domain` (reserved-checked); the random part makes a collision with an
 *  existing account in the project practically impossible, and a collision still fails. */
export function generatedAddress(domain = DEFAULT_SIGNUP_DOMAIN): string {
  if (typeof domain !== 'string') throw new Error('signUp: domain must be a string.');
  return admitReservedAddress(`sw-${randomBytes(6).toString('hex')}@${domain}`);
}

/** A generated password: letters, digits and punctuation, long enough for any app minimum. */
export function generatedPassword(): string {
  return `Sw-${randomBytes(15).toString('base64url')}-9a`;
}

export interface AccountRecord { project_id: string; email: string; id: string | null; run: string; pid: number; created_at: string; environment?: 'production' | 'preview'; preview_session_id?: string }

export function accountsDir(root: string, projectId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(projectId)) throw new Error('Unexpected project id in the test run record.');
  return join(root, '.somewhere', 'tests', 'accounts', projectId);
}

/** Write one record per sign-up attempt, before the form is submitted, so an interrupted run is
 *  visible to the next one. Returns the record's file path. */
export function recordAttempt(control: SweepControl, root: string, email: string): string {
  const dir = control.journalDir(root);
  ensurePrivateDir(dir);
  const path = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}.json`);
  const record: AccountRecord = { project_id: control.projectId, email, id: null, run: process.env.SW_TEST_RUN ?? 'direct', pid: Number(process.env.SW_TEST_RUN_PID ?? process.pid), created_at: new Date().toISOString(),
    environment: control.environment, ...(control.environment === 'preview' ? { preview_session_id: control.target.previewSessionId } : {}) };
  writePrivateFile(path, JSON.stringify(record) + '\n');
  return path;
}

export function recordId(path: string, id: string): void {
  const record = JSON.parse(readFileSync(path, 'utf8')) as AccountRecord;
  writePrivateFile(path, JSON.stringify({ ...record, id }) + '\n');
}

export function forgetRecord(path: string): void { rmSync(path, { force: true }); }

/** Delete the accounts this run created together, by exact id, with the developer delete, and the
 *  teams only they belong to. An id that is already gone counts as done. */
export function deleteAccounts(client: ApiClient, projectId: string, ids: string[]): Promise<SignupDeletion> {
  return inBatches(ids, async (batch) => {
    try {
      return readDeletionAnswer(batch, await client.call<DeletionAnswer>('POST', '/auth/users/delete', { ids: batch, delete_groups_only_they_belong_to: true }, { project_id: projectId }));
    } catch (error) {
      return failedDeletion(batch, describeCallError(error));
    }
  });
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface SweepResult { deleted: string[]; failed: string[]; unknownId: string[]; dropped: string[]; teamsDeleted: string[] }

/** Finish the records of runs that ended (this one, or one that was interrupted): delete each
 *  recorded id, and report addresses whose id was never learned (they are never deleted by
 *  address). Records of another `somewhere test` still running are left to it. */
export async function sweepAccounts(control: SweepControl, root: string): Promise<SweepResult> {
  const result: SweepResult = { deleted: [], failed: [], unknownId: [], dropped: [], teamsDeleted: [] };
  const projectId = control.projectId;
  const dir = control.journalDir(root);
  if (!existsSync(dir)) return result;
  const pending: { id: string; email: string; path: string }[] = [];
  for (const name of readdirSync(dir).filter((entry) => /^\d+-[0-9a-f]{8}\.json$/.test(entry))) {
    const path = join(dir, name);
    let record: AccountRecord;
    try { record = JSON.parse(readFileSync(path, 'utf8')) as AccountRecord; } catch { result.failed.push(name); continue; }
    if (record.project_id !== projectId) continue;
    // A record is finished only by a run against the same environment (and the same preview); a record
    // written before records named one is a production record.
    if ((record.environment ?? 'production') !== control.environment) continue;
    if (control.environment === 'preview' && record.preview_session_id !== control.target.previewSessionId) continue;
    if (record.run !== process.env.SW_TEST_RUN && alive(record.pid)) continue;
    if (record.id === null) { result.unknownId.push(record.email); forgetRecord(path); continue; }
    pending.push({ id: record.id, email: record.email, path });
  }
  // All the finished runs' accounts in one cleanup, so a team only they belong to goes with them.
  if (!pending.length) return result;
  const deletion = await control.deleteSignups([...new Set(pending.map((p) => p.id))]);
  for (const entry of pending) {
    if (deletion.done.includes(entry.id)) { result.deleted.push(entry.id); forgetRecord(entry.path); }
    else if (deletion.dropped.has(entry.id)) { result.dropped.push(`${entry.email} (${deletion.dropped.get(entry.id)})`); forgetRecord(entry.path); }
    else result.failed.push(`${entry.email} (${deletion.kept.get(entry.id) ?? 'not deleted'})`);
  }
  result.teamsDeleted.push(...deletion.teamsDeleted.map((team) => `"${team.name}" (${team.id})`));
  return result;
}

export function describeSweep(result: SweepResult, when: string): string[] {
  const lines: string[] = [];
  if (result.deleted.length) lines.push(`${when}: deleted ${result.deleted.length} leftover form sign-up account(s) by their recorded ids.`);
  if (result.teamsDeleted.length) lines.push(`${when}: deleted ${result.teamsDeleted.length} team(s) that only those sign-ups belonged to: ${result.teamsDeleted.join(', ')}.`);
  if (result.failed.length) lines.push(`${when}: could not delete ${result.failed.length} form sign-up account(s): ${result.failed.join(', ')}; the record is kept and the next run retries.`);
  if (result.dropped.length) lines.push(`${when}: dropped the cleanup record of ${result.dropped.length} form sign-up account(s) that can never be deleted: ${result.dropped.join(', ')}.`);
  if (result.unknownId.length) lines.push(`${when}: a sign-up was submitted but its account id was never returned, so it was not deleted (accounts are never deleted by address): ${result.unknownId.join(', ')}. If it exists, delete it from the project's users list.`);
  return lines;
}
