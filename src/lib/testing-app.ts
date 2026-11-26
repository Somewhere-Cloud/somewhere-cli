import { resolve } from 'node:path';
import { ApiClient } from './client.js';
import { loadProjectConfig } from './config.js';
import { previewToolClient } from './preview-credential.js';
import { previewControl, previewCredentialFor, productionControl, readPreviewTarget } from './test-control.js';
import { buildStorageState, createTestIdentities, expiryOf, MAX_PER_CREATE, type InboxMessage, type PlaywrightStorageState } from './test-identities.js';
import { loadTestTarget } from './test-target.js';
import { privateMarker } from './test-response-capture.js';
import { runTestJob, testingDeveloperToken, type TestJob, type TestJobOptions, type TestJobTarget } from './testing-jobs.js';
import { managedFileSession, UserSession } from './test-session.js';

export interface TestActor {
  id: string;
  email: string;
  session: UserSession;
}

export interface TestInboxMessage extends InboxMessage { links: string[] }

export interface TestApp {
  origin: string;
  anonymous: UserSession;
  users(count: number): Promise<TestActor[]>;
  testInbox(email: string): Promise<TestInboxMessage[]>;
  signInWithLink(url: string): Promise<TestActor>;
  create(user: TestActor, table: string, values: Record<string, unknown>, key?: string): Promise<string | number>;
  plantMarker(user: TestActor, table: string, field: string, values?: Record<string, unknown>): Promise<string>;
  onCleanup(label: string, action: () => Promise<void>): void;
  runJob(job: TestJobTarget, options?: TestJobOptions): Promise<TestJob>;
  cleanup(): Promise<void>;
}

/** Open the linked deployment or this folder's exact saved preview. */
export async function openTestApp(options: { preview?: boolean; projectDir?: string } = {}): Promise<TestApp> {
  const root = resolve(options.projectDir ?? process.cwd());
  const projectId = loadProjectConfig(root)?.project_id;
  if (!projectId) throw new Error('Run the test from a linked Somewhere app folder.');
  const setup = options.preview
    ? previewCredentialFor(root, projectId)
    : undefined;
  const tool = setup && previewToolClient(setup.credential);
  const client = tool ? undefined : new ApiClient(testingDeveloperToken());
  const target = tool && setup
    ? await readPreviewTarget(tool, projectId, setup.previewSessionId)
    : await loadTestTarget(client!, projectId);
  const control = tool ? previewControl(tool, target) : undefined;
  const inbox = control ?? productionControl(client!, target, { liveInboxOnly: true });
  const origin = target.origin;
  const emptyState: PlaywrightStorageState = { cookies: [], origins: [] };
  const cookie = await control?.previewCookie?.();
  if (cookie) {
    emptyState.cookies.push({
      name: cookie.name, value: cookie.value, domain: new URL(origin).hostname, path: '/',
      expires: Math.floor(cookie.expiresAt / 1000), httpOnly: true, secure: true, sameSite: 'Lax',
    });
  }
  const ids = new Set<string>();
  const actors = new Set<TestActor>();
  const recipients = new Map<string, { id: string; email: string; since: number }>();
  const signInLinks = new Map<string, { id: string; email: string }>();
  const cleanupSteps: Array<{ label: string; action: () => Promise<void> }> = [];
  let closed = false;
  const open = () => { if (closed) throw new Error('This test app has already been cleaned up.'); };
  const add = (id: string, email: string, session: UserSession): TestActor => {
    const actor = { id, email, session };
    actors.add(actor);
    managedFileSession(session, root, id);
    return actor;
  };
  const onCleanup = (label: string, action: () => Promise<void>) => {
    open();
    cleanupSteps.push({ label, action });
  };
  const create = async (user: TestActor, table: string, values: Record<string, unknown>, key = 'id') => {
    open();
    if (!actors.has(user)) throw new Error('Choose a user created by this test app.');
    const nameUnknownRow = () => onCleanup(`row in ${table} created by ${user.id} with an unknown ID`, async () => {
      throw new Error('No row ID was returned.');
    });
    let response: Response;
    try { response = await user.session.data(table, { operation: 'create', values }); }
    catch (error) { nameUnknownRow(); throw error; }
    if (!response.ok) {
      if (response.status >= 500) nameUnknownRow();
      throw new Error(`Could not create a row in ${table} as ${user.id} (HTTP ${response.status}).`);
    }
    const body: unknown = await response.json().catch(() => null);
    const rows = body && typeof body === 'object' && 'data' in body ? body.data : undefined;
    const row: unknown = Array.isArray(rows) ? rows[0] : rows;
    const id: unknown = row && typeof row === 'object' && Object.hasOwn(row, key) ? (row as Record<string, unknown>)[key] : undefined;
    if (typeof id !== 'string' && typeof id !== 'number') {
      nameUnknownRow();
      throw new Error(`A row in ${table} may remain. The create returned no ${key}.`);
    }
    onCleanup(`row ${table}/${id}`, async () => {
      const removed = await user.session.data(table, { operation: 'delete', id });
      if (removed.ok) return;
      const probe = await user.session.data(table, { operation: 'get', id });
      const read = await probe.json().catch(() => null) as { data?: unknown } | null;
      if (probe.ok && read?.data === null) return;
      throw new Error(`Delete returned HTTP ${removed.status} and the row could not be confirmed gone.`);
    });
    return id;
  };
  return {
    origin,
    anonymous: new UserSession(origin, { target, storageState: emptyState }),
    async users(count) {
      open();
      if (!Number.isInteger(count) || count < 1 || count > 25) throw new Error('Choose 1 to 25 test users.');
      const since = Date.now();
      if (control) {
        const out: TestActor[] = [];
        for (let i = 0; i < count; i++) {
          const user = await control.createManagedUser!();
          ids.add(user.id);
          const session = new UserSession(origin, { target, storageState: emptyState });
          const login = await session.post('/api/auth/login', { email: user.email, password: user.password });
          if (!login.ok) throw new Error(`Could not sign in preview test user ${user.id} (HTTP ${login.status}).`);
          recipients.set(user.email.toLowerCase(), { id: user.id, email: user.email, since });
          out.push(add(user.id, user.email, session));
        }
        return out;
      }
      const out: TestActor[] = [];
      try {
        for (let offset = 0; offset < count; offset += MAX_PER_CREATE) {
          const { issued, receivedAt } = await createTestIdentities(client!, projectId, 'user', Math.min(MAX_PER_CREATE, count - offset), 'script');
          for (const identity of issued) ids.add(identity.user.id);
          for (const identity of issued) {
            const state = buildStorageState(origin, new URL(origin).hostname, identity, expiryOf(identity, receivedAt));
            recipients.set(identity.user.email.toLowerCase(), { ...identity.user, since });
            out.push(add(identity.user.id, identity.user.email, new UserSession(origin, { target, storageState: state })));
          }
        }
        return out;
      } catch (error) {
        if (error && typeof error === 'object' && 'createdIds' in error && Array.isArray(error.createdIds)) {
          for (const id of error.createdIds) if (typeof id === 'string') ids.add(id);
        }
        throw error;
      }
    },
    async testInbox(email) {
      open();
      const recipient = recipients.get(email.toLowerCase());
      if (!recipient) throw new Error('Choose a test email created by this test app.');
      const messages = await inbox.inbox(recipient.email, { since: recipient.since, ms: 3_000 });
      open();
      return messages.filter(message => Date.parse(message.created_at) > recipient.since).map(message => {
        const links = new Set<string>();
        if (message.magic_link) {
          links.add(message.magic_link);
          const url = URL.parse(message.magic_link);
          if (url?.origin === origin && url.pathname === '/auth/magic' && url.searchParams.get('token')) {
            signInLinks.set(message.magic_link, recipient);
          }
        }
        for (const match of [message.text, message.html].join(' ').matchAll(/https?:\/\/[^\s<>"']+/gi)) {
          links.add(match[0].replaceAll('&amp;', '&').replace(/[.,]+$/, ''));
        }
        return { ...message, links: [...links] };
      });
    },
    async signInWithLink(url) {
      open();
      const recipient = signInLinks.get(url);
      if (!recipient) throw new Error('Use a sign-in link from this test app’s inbox.');
      signInLinks.delete(url);
      const token = new URL(url).searchParams.get('token');
      const session = new UserSession(origin, { target, storageState: emptyState });
      const response = await session.post('/api/auth/magic-link/verify', { token });
      open();
      if (!response.ok) throw new Error(`Could not sign in with the link (HTTP ${response.status}).`);
      const body = await response.json() as { cookie_session?: boolean; user?: { id?: string; email?: string } };
      if (!body.cookie_session || body.user?.id !== recipient.id || body.user.email?.toLowerCase() !== recipient.email.toLowerCase()) {
        throw new Error('The link did not sign in the expected test user.');
      }
      return add(recipient.id, recipient.email, session);
    },
    create,
    async plantMarker(user, table, field, values = {}) {
      const marker = privateMarker();
      await create(user, table, { ...values, [field]: marker });
      return marker;
    },
    onCleanup,
    runJob(job, opts) {
      open();
      return runTestJob(target, job, opts, setup?.credential);
    },
    async cleanup() {
      if (closed) return;
      closed = true;
      signInLinks.clear();
      const remains: string[] = [];
      for (const { label, action } of cleanupSteps.reverse()) {
        try { await action(); } catch { remains.push(label); }
      }
      if (control) {
        for (const id of ids) if (await control.deleteManagedUser!(id)) remains.push(`test user ${id}`);
        await control.close();
      } else if (ids.size) {
        try {
          await client!.call('DELETE', '/auth/test-users', { project_id: projectId, ids: [...ids] });
          const { identities } = await client!.call<{ identities: Array<{ id: string }> }>('GET', '/auth/test-users', undefined, { project_id: projectId });
          for (const user of identities) if (ids.has(user.id)) remains.push(`test user ${user.id}`);
        } catch {
          remains.push(...[...ids].map(id => `test user ${id}`));
        }
      }
      if (remains.length) throw new Error(`Could not confirm cleanup of ${remains.join(', ')}.`);
    },
  };
}
