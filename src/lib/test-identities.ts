/**
 * Browser-independent test identities for local Playwright, agent-browser and hosted verify
 * (tsks 668f0ce2, b05cf814). Builds only on platform APIs that already exist:
 *   POST/GET/DELETE /auth/test-users   managed, preverified test identities (24 h, <= 25 live)
 *   GET /email/test-inbox              stored auth mail for <x>@<sub>.test.somewhere.site
 *
 * A prepared actor's state file is a standard Playwright storageState
 * (https://playwright.dev/docs/auth) holding exactly the session hosted verify seeds for a test
 * identity (worker routes/browser.ts): the __Host-token and __Host-sw_refresh_token cookies on
 * the app's exact production host, plus sw_auth / sw_access_token / sw_auth_user in localStorage.
 * Expiry is the server's: the access token keeps its own short `exp` (recorded as
 * access_expires_at), and the session ends at `iat + session_ttl_seconds`. Both cookies live until
 * the session ends, as the runtime's own cookies do: an expired access token must still be
 * presented for the app to refresh it from the refresh cookie (measured 2026-10-21: an access
 * cookie that expired with its JWT left the app signed out). Nothing here refreshes or extends
 * anything. The first refresh rotates the session's refresh token, so a test saves the browser
 * context's state back to the same file after each run (Playwright `context.storageState({ path })`)
 * or prepares again.
 *
 * State lives only in <project>/.somewhere/test/ (0700 dir, 0600 files, gitignored; deploys skip
 * dotfiles). It never holds the developer credential, and no token or cookie value is printed.
 * Deleting a test identity removes its auth records only: app rows, files and stored test mail
 * the identity created are kept, and every report says so.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ApiClient } from './client.js';

export const TEST_STATE_DIR = join('.somewhere', 'test');
export const TEST_STATE_GITIGNORE_LINE = '.somewhere/test/';
export const MANIFEST_FILE = 'manifest.json';
export const CLEANUP_RECEIPT_FILE = 'cleanup-receipt.json';
export const MAX_PER_CREATE = 5;
const ACTOR = /^[a-z][a-z0-9-]{0,31}$/;
const ACCESS_COOKIE = '__Host-token';
const REFRESH_COOKIE = '__Host-sw_refresh_token';

export type TestRole = 'user' | 'admin';
export interface ActorSpec { name: string; role: TestRole }

export interface ManifestActor {
  name: string;
  user_id: string;
  email: string;
  role: TestRole;
  created_at: string;
  access_expires_at: string;
  session_expires_at: string;
  state_file: string;
}

export interface TestManifest {
  schema: 1;
  project_id: string;
  origin: string;
  run_id: string;
  created_at: string;
  /** Every identity this run created, written as each create succeeds, so cleanup can reconcile a partial run. */
  actors: ManifestActor[];
  status: 'preparing' | 'prepared' | 'partial';
  retained_note: string;
}

export const RETAINED_NOTE = 'Deleting a test identity removes its sign-in records only. App rows, files and stored test mail it created are kept; use a disposable project for full isolation.';

/** `alice`, `bob:admin` → specs; names are unique and file-safe. */
export function parseActorSpecs(values: string[]): ActorSpec[] {
  if (!values.length) throw new Error('Name at least one actor, for example: somewhere test-users prepare alice bob:admin');
  const seen = new Set<string>();
  return values.map((value) => {
    const [name, role = 'user', extra] = value.split(':');
    if (extra !== undefined || !ACTOR.test(name) || (role !== 'user' && role !== 'admin')) {
      throw new Error(`Invalid actor "${value}". Use a lowercase name (letters, digits, -), optionally :admin.`);
    }
    if (seen.has(name)) throw new Error(`Actor "${name}" is listed twice.`);
    seen.add(name);
    return { name, role: role as TestRole };
  });
}

/** The project's production origin, exactly; anything else is refused rather than guessed. */
export function productionOrigin(prodFallback: unknown, requested?: string): { origin: string; host: string } {
  if (typeof prodFallback !== 'string' || !prodFallback.trim()) throw new Error('The platform did not return this project\'s production address.');
  const origin = new URL(prodFallback.trim()).origin;
  const host = new URL(origin).host;
  if (requested !== undefined) {
    let asked: string;
    try { asked = new URL(requested).origin; } catch { throw Object.assign(new Error(`"${requested}" is not a URL.`), { code: 'UNSUPPORTED_ORIGIN' }); }
    if (asked !== origin) {
      throw Object.assign(new Error(`Only this project's production origin ${origin} is supported; ${asked} is not.`), { code: 'UNSUPPORTED_ORIGIN' });
    }
  }
  return { origin, host };
}

export function stateDir(root: string): string { return join(root, TEST_STATE_DIR); }

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Atomic 0600 write: a reader never sees a partial or world-readable file. */
export function writePrivateFile(path: string, content: string): void {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Make sure git ignores the state directory; create .gitignore if the folder has none. */
export function ensureGitignored(root: string): 'present' | 'added' | 'created' {
  const path = join(root, '.gitignore');
  if (!existsSync(path)) {
    writeFileSync(path, `# somewhere test-users: private signed-in test state\n${TEST_STATE_GITIGNORE_LINE}\n`);
    return 'created';
  }
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => ['.somewhere/test/', '.somewhere/test', '/.somewhere/test/', '/.somewhere/test', '.somewhere/', '.somewhere', '/.somewhere/', '/.somewhere'].includes(line))) return 'present';
  writeFileSync(path, `${text}${text.endsWith('\n') || !text ? '' : '\n'}\n# somewhere test-users: private signed-in test state\n${TEST_STATE_GITIGNORE_LINE}\n`);
  return 'added';
}

/** The manifest is a file on disk that may have been committed or edited, so every field later used
 *  to touch the filesystem or the API is validated here: an actor's state file is always exactly
 *  `<name>.state.json` for a valid actor name, so cleanup can never delete outside .somewhere/test/. */
export function readManifest(root: string): TestManifest | null {
  const path = join(stateDir(root), MANIFEST_FILE);
  if (!existsSync(path)) return null;
  const invalid = (why: string) => Object.assign(new Error(`${path} is not a valid test-users manifest (${why}); nothing was changed.`), { code: 'MANIFEST_INVALID' });
  let value: TestManifest;
  try { value = JSON.parse(readFileSync(path, 'utf8')) as TestManifest; } catch { throw invalid('not JSON'); }
  if (value?.schema !== 1 || !Array.isArray(value.actors) || typeof value.project_id !== 'string') throw invalid('wrong shape');
  const seen = new Set<string>();
  for (const actor of value.actors) {
    if (!actor || typeof actor.name !== 'string' || !ACTOR.test(actor.name) || seen.has(actor.name)) throw invalid('bad actor name');
    if (actor.state_file !== `${actor.name}.state.json`) throw invalid(`actor ${actor.name} has a state file other than ${actor.name}.state.json`);
    if (typeof actor.user_id !== 'string' || !actor.user_id || typeof actor.email !== 'string' || !actor.email.includes('@')) throw invalid(`actor ${actor.name} has no user id or email`);
    seen.add(actor.name);
  }
  return value;
}

export function writeManifest(root: string, manifest: TestManifest): void {
  writePrivateFile(join(stateDir(root), MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
}

/** The server's own times, read from the access token (not verified here; the server does that). */
export function tokenTimes(accessToken: string): { iat: number; exp: number } | null {
  const part = accessToken.split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { iat?: unknown; exp?: unknown };
    return Number.isFinite(claims.iat) && Number.isFinite(claims.exp) ? { iat: Number(claims.iat), exp: Number(claims.exp) } : null;
  } catch {
    return null;
  }
}

export interface IssuedIdentity {
  user: { id: string; email: string; role?: string; email_verified?: boolean; test?: boolean; created_at?: number };
  access_token: string;
  refresh_token: string;
  expires_in: number;
  session_ttl_seconds: number;
}

export interface PlaywrightStorageState {
  cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Lax' }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

/** Standard Playwright storageState for one actor, mirroring the hosted-verify seed exactly. */
export function buildStorageState(origin: string, host: string, issued: IssuedIdentity, times: { accessExpiresAt: number; sessionExpiresAt: number }): PlaywrightStorageState {
  const cookie = (name: string, value: string, expiresMs: number) => ({
    name, value, domain: host, path: '/', expires: Math.floor(expiresMs / 1000), httpOnly: true, secure: true, sameSite: 'Lax' as const,
  });
  const auth = {
    access_token: issued.access_token, token: issued.access_token, refresh_token: issued.refresh_token,
    expires_in: issued.expires_in, expires_at: times.accessExpiresAt, user: issued.user,
  };
  return {
    cookies: [cookie(ACCESS_COOKIE, issued.access_token, times.sessionExpiresAt), cookie(REFRESH_COOKIE, issued.refresh_token, times.sessionExpiresAt)],
    origins: [{ origin, localStorage: [
      { name: 'sw_auth', value: JSON.stringify(auth) },
      { name: 'sw_access_token', value: issued.access_token },
      { name: 'sw_auth_user', value: JSON.stringify(issued.user) },
    ] }],
  };
}

/** Validate one create-response entry; tokens are required for a usable state file. */
export function parseIssued(entry: unknown): IssuedIdentity {
  const value = entry as Record<string, unknown> | null;
  const user = value?.user as IssuedIdentity['user'] | undefined;
  if (!user || typeof user.id !== 'string' || typeof user.email !== 'string' || user.test !== true) throw new Error('The platform returned a test identity without its user.');
  if (typeof value?.access_token !== 'string' || typeof value.refresh_token !== 'string'
    || typeof value.expires_in !== 'number' || typeof value.session_ttl_seconds !== 'number') {
    throw new Error(`The platform created test user ${user.id} but returned no session for it.`);
  }
  return { user, access_token: value.access_token, refresh_token: value.refresh_token, expires_in: value.expires_in, session_ttl_seconds: value.session_ttl_seconds };
}

/** Absolute expiry from the server's own token times; local clock only if the token has none. */
export function expiryOf(issued: IssuedIdentity, receivedAt: number): { accessExpiresAt: number; sessionExpiresAt: number; source: 'token' | 'response' } {
  const times = tokenTimes(issued.access_token);
  if (times) return { accessExpiresAt: times.exp * 1000, sessionExpiresAt: (times.iat + issued.session_ttl_seconds) * 1000, source: 'token' };
  return { accessExpiresAt: receivedAt + issued.expires_in * 1000, sessionExpiresAt: receivedAt + issued.session_ttl_seconds * 1000, source: 'response' };
}

export async function createTestIdentities(client: ApiClient, projectId: string, role: TestRole, count: number, label: string): Promise<{ issued: IssuedIdentity[]; receivedAt: number }> {
  const body = await client.call<{ identities?: unknown[] }>('POST', '/auth/test-users', { project_id: projectId, count, label, role, include_tokens: true });
  const receivedAt = Date.now();
  const entries = Array.isArray(body?.identities) ? body.identities : [];
  // Parse each entry on its own, so identities the platform did create are kept even if a later one is malformed.
  const issued: IssuedIdentity[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    try { issued.push(parseIssued(entry)); } catch (cause) { problems.push(cause instanceof Error ? cause.message : String(cause)); }
  }
  if (problems.length || issued.length !== count) {
    throw Object.assign(new Error(problems[0] ?? `The platform returned ${issued.length} of ${count} test identities.`), { issued, receivedAt, partial: true });
  }
  return { issued, receivedAt };
}

/** Fresh, unused mailbox address on the project's test domain, for testing real signup. */
export function freshTestAddress(subdomain: string, prefix = 'signup'): string {
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(prefix)) throw new Error('--name must be 1-24 lowercase letters, digits or -.');
  return `${prefix}-${randomBytes(6).toString('hex')}@${subdomain}.test.somewhere.site`;
}

export interface InboxMessage { id: string; to: string; subject: string; verification_code: string | null; magic_link: string | null; created_at: string }

/** Messages for exactly `address` created after `since`, newest first. The server's `since` only
 *  drives the long-poll; the list is filtered here so a stale code is never returned. */
export function messagesAfter(messages: unknown, address: string, since: number): InboxMessage[] {
  if (!Array.isArray(messages)) return [];
  const want = address.toLowerCase();
  return messages
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .map((m) => ({
      id: String(m.id ?? ''), to: String(m.to ?? ''), subject: String(m.subject ?? ''),
      verification_code: typeof m.verification_code === 'string' && m.verification_code ? m.verification_code : null,
      magic_link: typeof m.magic_link === 'string' && m.magic_link ? m.magic_link : null,
      created_at: String(m.created_at ?? ''),
    }))
    .filter((m) => m.to.toLowerCase() === want && Date.parse(m.created_at) > since)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** --since accepts epoch milliseconds or an ISO time. */
export function parseSince(value: string): number {
  if (/^\d{10,16}$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`--since "${value}" is not epoch milliseconds or an ISO time.`);
  return parsed;
}

export function removeStateFiles(root: string, actors: ManifestActor[]): string[] {
  const removed: string[] = [];
  for (const actor of actors) {
    // Belt and braces after readManifest: only a plain `<name>.state.json` inside the state dir.
    if (!ACTOR.test(actor.name) || actor.state_file !== `${actor.name}.state.json`) continue;
    const path = join(stateDir(root), actor.state_file);
    if (existsSync(path)) { rmSync(path, { force: true }); removed.push(actor.state_file); }
  }
  return removed;
}
