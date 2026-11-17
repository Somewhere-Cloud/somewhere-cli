/**
 * What a test run talks to besides the app's own pages: one object per run, chosen once.
 *
 * - production: the linked project's live release, with your own developer sign-in (unchanged).
 * - preview: the folder's open preview, with the preview's own tool credential ONLY
 *   (lib/preview-credential.ts). It never reads your sign-in, never looks up production, never
 *   deletes anything in production, and never falls back to production, including for cleanup or
 *   an interrupted run. The run is pinned to the candidate it started on: the browser uses a
 *   session that the preview gate stops admitting once the preview is saved again, closed or
 *   expires, and the end of the run checks the candidate again.
 *
 * Every fixture, helper, report and cleanup path takes this object; none builds its own client.
 */
import { join } from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { ApiClient, CliApiError } from './client.js';
import { getToken, loadConfig } from './config.js';
import { loadPreviewCredential, previewToolClient, isDeadPreviewCredential } from './preview-credential.js';
import { loadPreviewRecord } from './preview-record.js';
import { liveReleaseId, loadTestTarget, type TestTarget } from './test-target.js';
import { messagesAfter, type InboxMessage } from './test-identities.js';
import { deleteAccounts, accountsDir, describeCallError, failedDeletion, inBatches, readDeletionAnswer, type SignupDeletion } from './form-accounts.js';
import { TEST_INBOX_CLAIM_REASON } from './test-report.js';
import { rememberSecrets } from './test-diagnostics.js';

export interface ManagedUser { id: string; email: string; password: string }
export interface TestControl {
  readonly environment: 'production' | 'preview';
  readonly projectId: string;
  readonly target: TestTarget;
  /** Captured mail to exactly `address`, newest first; `wait` long-polls up to `ms` for mail after `since`. */
  inbox(address: string, wait?: { since: number; ms?: number }): Promise<InboxMessage[]>;
  /** Delete the accounts this run signed up through the app's form, together and by exact id, with
   *  the teams only they belong to (form-accounts.ts SignupDeletion). */
  deleteSignups(ids: string[]): Promise<SignupDeletion>;
  /** Where sign-up attempts are recorded for exact-id cleanup (separate per environment and preview). */
  journalDir(root: string): string;
  /** Make a browser context able to reach the target (preview: the run's pinned session). */
  prepareContext(context: BrowserContext): Promise<void>;
  /** The release (production) or candidate (preview) serving now, for the end-of-run check. */
  currentRelease(): Promise<string>;
  /** End anything the control itself holds open (the preview browser session). */
  close(): Promise<void>;
  /** Preview only: a managed test user through the preview's developer tool, and its removal by id. */
  createManagedUser?(): Promise<ManagedUser>;
  deleteManagedUser?(id: string): Promise<string | null>;
}

// ── production ─────────────────────────────────────────────────────────────────────────────────

export class TestInboxNeedsClaim extends Error {
  constructor() { super(TEST_INBOX_CLAIM_REASON); }
}

export function productionControl(client: ApiClient, target: TestTarget): TestControl {
  const projectId = target.projectId;
  return {
    environment: 'production', projectId, target,
    async inbox(address, wait) {
      if (loadConfig()?.temporary) throw new TestInboxNeedsClaim();
      const body = await client.call<{ messages?: unknown }>('GET', '/email/test-inbox', undefined,
        { project_id: projectId, address, limit: 20, ...(wait ? { wait_ms: wait.ms ?? 10_000, since: wait.since } : {}) });
      return messagesAfter(body.messages, address, 0);
    },
    deleteSignups: (ids) => deleteAccounts(client, projectId, ids),
    journalDir: (root) => accountsDir(root, projectId),
    async prepareContext() {},
    currentRelease: () => liveReleaseId(client, projectId),
    async close() {},
  };
}

/** The production control the runner and fixtures always used: your sign-in, the live release. */
export async function openProductionControl(projectId: string, target?: TestTarget): Promise<TestControl> {
  const client = new ApiClient(getToken());
  return productionControl(client, target ?? await loadTestTarget(client, projectId));
}

// ── preview ────────────────────────────────────────────────────────────────────────────────────

export const PREVIEW_CLOSED_MESSAGE = 'The preview is closed, promoted or expired, or its credential was revoked. Open or continue one with `somewhere preview`, then run the tests again.';
type ToolClient = ReturnType<typeof previewToolClient>;
interface PreviewTargetAnswer { project_id: string; preview_session_id: string; preview_id: string; origin: string; contract_digest: string | null }
interface BrowserSession { session_id: string; preview_id: string; expires_at: number; cookie: { name: string; value: string } }

/** A failure of the preview itself (closed, saved again): the run fails as a preview run. */
export class PreviewRunError extends Error {}

function previewFailure(error: unknown, what: string): Error {
  if (isDeadPreviewCredential(error)) return new PreviewRunError(`${what}: ${PREVIEW_CLOSED_MESSAGE}`);
  if (error instanceof CliApiError && error.code === 'DRAFT_VERSION_MISMATCH') return new PreviewRunError(`${what}: the preview was saved again or closed just now. Run the tests again.`);
  return error instanceof Error ? error : new Error(String(error));
}

/** This folder's open preview and its tool credential, or a refusal that says what to do. Never
 *  mints a credential (that needs your sign-in): `somewhere preview` mints one when it opens. */
export function previewCredentialFor(root: string, projectId: string, previewSessionId?: string): { previewSessionId: string; credential: string } {
  const draftId = previewSessionId ?? loadPreviewRecord(root, projectId)?.preview_session_id;
  if (!draftId) throw new PreviewRunError('This folder has no open preview. Open one with `somewhere preview`, then run `somewhere test --preview`.');
  const credential = loadPreviewCredential(projectId, draftId);
  if (!credential) {
    throw new PreviewRunError(`This machine holds no credential for preview ${draftId}. Run \`somewhere preview\` in this folder (it continues the preview and mints one); preview tests never use your own sign-in.`);
  }
  rememberSecrets(credential);
  return { previewSessionId: draftId, credential };
}

export async function readPreviewTarget(tool: ToolClient, projectId: string, previewSessionId: string): Promise<TestTarget> {
  let answer: PreviewTargetAnswer;
  try { answer = await tool.call<PreviewTargetAnswer>('GET', '/preview-tools/target'); }
  catch (error) { throw previewFailure(error, 'The preview could not be read'); }
  if (answer.project_id !== projectId || answer.preview_session_id !== previewSessionId) {
    throw new PreviewRunError('The preview credential names a different project or preview than this folder. Run `somewhere preview` in this folder.');
  }
  const origin = new URL(answer.origin);
  return { projectId, origin: origin.origin, host: origin.host, releaseId: answer.preview_id, contractDigest: answer.contract_digest, environment: 'preview', previewSessionId };
}

/**
 * The preview control. `expect` pins it to the candidate the run started on (workers and the
 * reporter pass the runner's); without it, it pins the candidate it reads now.
 */
export async function openPreviewControl(input: { root: string; projectId: string; previewSessionId?: string; expect?: TestTarget }): Promise<TestControl> {
  const { previewSessionId, credential } = previewCredentialFor(input.root, input.projectId, input.previewSessionId ?? input.expect?.previewSessionId);
  const tool = previewToolClient(credential);
  const target = input.expect ?? await readPreviewTarget(tool, input.projectId, previewSessionId);
  return previewControl(tool, target, input.root);
}

export function previewControl(tool: ToolClient, target: TestTarget, _root?: string): TestControl {
  if (target.environment !== 'preview' || !target.previewSessionId) throw new Error('previewControl needs a preview target');
  const draftId = target.previewSessionId;
  const projectId = target.projectId;
  let session: Promise<BrowserSession> | undefined;
  const pinned = (): Promise<BrowserSession> => session ??= (async () => {
    let minted: BrowserSession;
    try { minted = await tool.call<BrowserSession>('POST', '/preview-tools/browser-session'); }
    catch (error) { session = undefined; throw previewFailure(error, 'The preview browser session could not be opened'); }
    rememberSecrets(minted.cookie.value, minted.session_id);
    if (minted.preview_id !== target.releaseId) {
      void tool.call('DELETE', `/preview-tools/browser-session/${encodeURIComponent(minted.session_id)}`).catch(() => {});
      throw new PreviewRunError(`The preview was saved again after this run started (${target.releaseId} → ${minted.preview_id}), so these tests would not test one version. Run the tests again.`);
    }
    return minted;
  })();
  return {
    environment: 'preview', projectId, target,
    async inbox(address, wait) {
      // The preview's own captured mail, for exactly this address, with the same server-side wait
      // production's test inbox uses (wait_ms up to 10 s for mail newer than `since`): one call per wait.
      let body: { messages?: unknown };
      try {
        body = await tool.call<{ messages?: unknown }>('GET', '/preview-tools/mail', undefined,
          { address, limit: 20, ...(wait ? { wait_ms: wait.ms ?? 10_000, since: wait.since } : {}) });
      } catch (error) { throw previewFailure(error, 'The preview\'s captured mail could not be read'); }
      return messagesAfter(body.messages, address, 0);
    },
    deleteSignups(ids) {
      return inBatches(ids, async (batch) => {
        try {
          return readDeletionAnswer(batch, await tool.call('POST', '/preview-tools/signups/delete', { ids: batch, delete_groups_only_they_belong_to: true }));
        } catch (error) {
          // A closed, promoted or expired preview took its accounts with it: nothing is left to delete,
          // and no later run can reach that preview, so the record is dropped, not retried for ever.
          if (isDeadPreviewCredential(error)) return failedDeletion(batch, 'the preview is closed, promoted or expired, and its accounts went with it', true);
          return failedDeletion(batch, describeCallError(error));
        }
      });
    },
    journalDir: (root) => previewAccountsDir(root, projectId, draftId),
    async prepareContext(context) {
      const { cookie } = await pinned();
      const url = new URL(target.origin);
      await context.addCookies([{ name: cookie.name, value: cookie.value, domain: url.hostname, path: '/', secure: url.protocol === 'https:', httpOnly: true, sameSite: 'Lax' }]);
    },
    async currentRelease() {
      try { return (await tool.call<PreviewTargetAnswer>('GET', '/preview-tools/target')).preview_id; }
      catch (error) { throw previewFailure(error, 'The preview could not be confirmed at the end of the run'); }
    },
    createManagedUser: () => createPreviewManagedUser(tool),
    deleteManagedUser: (id) => deletePreviewManagedUser(tool, id),
    async close() {
      if (!session) return;
      const held = await session.catch(() => null);
      session = undefined;
      if (held) await tool.call('DELETE', `/preview-tools/browser-session/${encodeURIComponent(held.session_id)}`).catch(() => {});
    },
  };
}

/** Sign-ups made in a preview are recorded apart from production's, per preview. */
export function previewAccountsDir(root: string, projectId: string, previewSessionId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(projectId) || !/^draft_[A-Za-z0-9-]{1,80}$/.test(previewSessionId)) throw new Error('Unexpected project or preview id in the test run record.');
  return join(root, '.somewhere', 'tests', 'preview-accounts', projectId, previewSessionId);
}

/** A managed test user in the preview (the preview's developer tool): created, then removed by id. */
export async function createPreviewManagedUser(tool: ToolClient): Promise<ManagedUser> {
  let created: { user: { id: string; email: string }; password: string };
  try { created = await tool.call<{ user: { id: string; email: string }; password: string }>('POST', '/preview-tools/users', {}); }
  catch (error) { throw previewFailure(error, 'The preview test user could not be created'); }
  rememberSecrets(created.password);
  return { id: created.user.id, email: created.user.email, password: created.password };
}
export async function deletePreviewManagedUser(tool: ToolClient, id: string): Promise<string | null> {
  try { await tool.call('DELETE', `/preview-tools/users/${encodeURIComponent(id)}`); return null; }
  catch (error) {
    if (error instanceof CliApiError && error.statusCode === 404) return null;
    return isDeadPreviewCredential(error) ? 'the preview is closed, promoted or expired, or its credential was revoked' : String(error instanceof Error ? error.message : error).slice(0, 200);
  }
}
