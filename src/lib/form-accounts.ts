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
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ApiClient } from './client.js';
import { CliApiError } from './client.js';
import { ensurePrivateDir, writePrivateFile } from './test-identities.js';

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
 *  labels, case-folded, no trailing dot; the domain is exactly example.com/.org/.net, or has
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
  return lower;
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

export interface AccountRecord { project_id: string; email: string; id: string | null; run: string; pid: number; created_at: string }

export function accountsDir(root: string, projectId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(projectId)) throw new Error('Unexpected project id in the test run record.');
  return join(root, '.somewhere', 'tests', 'accounts', projectId);
}

/** Write one record per sign-up attempt, before the form is submitted, so an interrupted run is
 *  visible to the next one. Returns the record's file path. */
export function recordAttempt(root: string, projectId: string, email: string): string {
  const dir = accountsDir(root, projectId);
  ensurePrivateDir(dir);
  const path = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}.json`);
  const record: AccountRecord = { project_id: projectId, email, id: null, run: process.env.SW_TEST_RUN ?? 'direct', pid: Number(process.env.SW_TEST_RUN_PID ?? process.pid), created_at: new Date().toISOString() };
  writePrivateFile(path, JSON.stringify(record) + '\n');
  return path;
}

export function recordId(path: string, id: string): void {
  const record = JSON.parse(readFileSync(path, 'utf8')) as AccountRecord;
  writePrivateFile(path, JSON.stringify({ ...record, id }) + '\n');
}

export function forgetRecord(path: string): void { rmSync(path, { force: true }); }

/** Delete one account this run created, by exact id, with the developer delete. A 404 means it
 *  is already gone. Returns false when the delete could not be confirmed. */
export async function deleteAccount(client: ApiClient, projectId: string, id: string): Promise<boolean> {
  try {
    await client.call('DELETE', `/auth/users/${encodeURIComponent(id)}`, undefined, { project_id: projectId });
    return true;
  } catch (error) {
    return error instanceof CliApiError && error.statusCode === 404;
  }
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface SweepResult { deleted: string[]; failed: string[]; unknownId: string[] }

/** Finish the records of runs that ended (this one, or one that was interrupted): delete each
 *  recorded id, and report addresses whose id was never learned (they are never deleted by
 *  address). Records of another `somewhere test` still running are left to it. */
export async function sweepAccounts(client: ApiClient, root: string, projectId: string): Promise<SweepResult> {
  const result: SweepResult = { deleted: [], failed: [], unknownId: [] };
  const dir = accountsDir(root, projectId);
  if (!existsSync(dir)) return result;
  for (const name of readdirSync(dir).filter((entry) => /^\d+-[0-9a-f]{8}\.json$/.test(entry))) {
    const path = join(dir, name);
    let record: AccountRecord;
    try { record = JSON.parse(readFileSync(path, 'utf8')) as AccountRecord; } catch { result.failed.push(name); continue; }
    if (record.project_id !== projectId) continue;
    if (record.run !== process.env.SW_TEST_RUN && alive(record.pid)) continue;
    if (record.id === null) { result.unknownId.push(record.email); forgetRecord(path); continue; }
    if (await deleteAccount(client, projectId, record.id)) { result.deleted.push(record.id); forgetRecord(path); }
    else result.failed.push(record.email);
  }
  return result;
}

export function describeSweep(result: SweepResult, when: string): string[] {
  const lines: string[] = [];
  if (result.deleted.length) lines.push(`${when}: deleted ${result.deleted.length} leftover form sign-up account(s) by their recorded ids.`);
  if (result.failed.length) lines.push(`${when}: could not delete ${result.failed.length} form sign-up account(s): ${result.failed.join(', ')}; the record is kept and the next run retries.`);
  if (result.unknownId.length) lines.push(`${when}: a sign-up was submitted but its account id was never returned, so it was not deleted (accounts are never deleted by address): ${result.unknownId.join(', ')}. If it exists, delete it from the project's users list.`);
  return lines;
}
