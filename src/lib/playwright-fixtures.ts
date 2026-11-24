import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { APIRequestContext, APIResponse, BrowserContext, Locator, Page, TestType, PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions } from '@playwright/test';
import { fixtureTestTarget } from './test-target.js';
import { ApiClient } from './client.js';
import { classifyData } from './app-test.js';
import { getToken, loadProjectConfig } from './config.js';
import { buildStorageState, createTestIdentities, expiryOf, messagesAfter, type IssuedIdentity, type InboxMessage } from './test-identities.js';
import { diagnostics, rememberSecrets, scrub, scrubTestErrors, describeError, timed, titled } from './test-diagnostics.js';
import { mark as timelineMark, markProcessStart, span, trackPage } from './test-timeline.js';
import { forgetRecord } from './form-accounts.js';
import { ready, signUp, signIn, signOut, verify, type FormHost, type FormControl, type Attempt, type Person, type FormSteps, type CodeSteps, type SignUpOptions, type SignInOptions, type FormAdapter } from './form-auth.js';
import { openPreviewControl, openProductionControl, type TestControl } from './test-control.js';
import { safeToScreenshot } from './screenshot-guard.js';
export type { Person, FormSteps, CodeSteps, SignUpOptions, SignInOptions, FormAdapter };
import type { TestTarget } from './test-target.js';
import type { TestInfo } from '@playwright/test';
import type { DataRequest } from '../testing.js';

// Playwright adds an accessibility snapshot of the failing page (its visible text, which can show a
// password, an emailed code or a reset link) to error-context.md. Off in every worker that loads these
// fixtures, whether or not `somewhere test` started it; the runner sets it too.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

export interface TestUser { id: string; email: string; page: Page; request: APIRequestContext }
/** `role`: an app role declared in db/schema.ts appRoles, granted to this user with your developer
 *  credential (the same grant as somewhere's app-roles grant) before newUser returns. */
export interface NewUserOptions { role?: string }
interface WorkerFixtures { _preview: TestControl | null }
interface Fixtures {
  _evidence: void; anonymous: APIRequestContext; _forms: FormRun;
  /** A fresh signed-in test user. Make several at once: `await Promise.all([newUser(), newUser()])`.
   *  `{ role }` grants that app role (declared in db/schema.ts appRoles) before it returns. */
  newUser: (options?: NewUserOptions) => Promise<TestUser>;
  /** Another signed-out page on the app, in its own browser context (a second person for signUp). */
  newPage: () => Promise<Page>;
  signUp: (page: Page, options?: SignUpOptions) => Promise<Person>;
  verify: (page: Page, person: Person) => Promise<void>;
  signIn: (page: Page, person: Person, options?: SignInOptions) => Promise<void>;
  signOut: (page: Page, options?: { steps?: (page: Page) => Promise<void>; form?: FormAdapter }) => Promise<void>;
}
type RunnerTest = TestType<PlaywrightTestArgs & PlaywrightTestOptions & Fixtures, PlaywrightWorkerArgs & PlaywrightWorkerOptions & WorkerFixtures>;
let loaded: { test: RunnerTest; expect: typeof import('@playwright/test').expect } | undefined;
const digests = new WeakMap<APIRequestContext, string | null>();

/** Wait on SDK auth for fixture-owned navigations. Public pages have no marker. */
function waitOnNavigation(page: Page): Page {
  async function wait(options: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' } | undefined) {
    if (options?.waitUntil === 'commit') return;
    const marker = page.locator('html[data-sw-auth]');
    if (!(await marker.count())) return;
    await page.locator('html[data-sw-auth="checking"]').waitFor({ state: 'detached', timeout: 5_000 });
    if (await marker.getAttribute('data-sw-auth') === 'indeterminate') {
      throw new Error('The app could not confirm its sign-in state.');
    }
  }
  const goto = page.goto.bind(page);
  page.goto = async (url, options) => {
    const response = await goto(url, options);
    await wait(options);
    return response;
  };
  const reload = page.reload.bind(page);
  page.reload = async (options) => {
    const response = await reload(options);
    await wait(options);
    return response;
  };
  return page;
}

/** The run's target as the runner passed it (no credential is ever in it). */
function runTarget(projectId: string): TestTarget | null {
  if (!process.env.SW_TEST_TARGET) return null;
  const target = JSON.parse(process.env.SW_TEST_TARGET) as TestTarget;
  if (target.projectId !== projectId) throw new Error('Test target belongs to a different project');
  return target;
}
function linkedProject(): string {
  const projectId = loadProjectConfig()?.project_id;
  if (!projectId) throw new Error('Run somewhere test from a linked project folder.');
  return projectId;
}
/** A preview run's control for this worker, or null for a production run. A preview run never
 *  builds a production client: its control holds only the preview's tool credential. */
async function previewControlForWorker(): Promise<TestControl | null> {
  const projectId = linkedProject();
  const target = runTarget(projectId);
  if (target?.environment !== 'preview') return null;
  return openPreviewControl({ root: process.cwd(), projectId, expect: target });
}

function runner() {
  if (loaded) return loaded;
  const require = createRequire(join(process.cwd(), 'package.json'));
  let pw: typeof import('@playwright/test');
  try { pw = require('@playwright/test') as typeof import('@playwright/test'); }
  catch { throw new Error('Install project test dependencies: npm install -D @playwright/test @somewhere-cloud/cli'); }
  const test = pw.test.extend<Fixtures, WorkerFixtures>({
    _preview: [async ({}, use) => {
      const control = await previewControlForWorker();
      try { await use(control); } finally { await control?.close(); }
    }, { scope: 'worker' }],
    // A preview run: every browser context reaches the preview through the run's pinned session.
    context: async ({ context, _preview }, use) => {
      if (_preview) await _preview.prepareContext(context);
      await use(context);
    },
    page: async ({ page }, use) => { await use(waitOnNavigation(page)); },
    _evidence: [async ({}, use, info) => {
      try { await use(); } finally {
        // Torn down after every other somewhere fixture and before Playwright writes error-context.md
        // or reports the errors: scrub them in place first.
        scrubTestErrors(info.errors as unknown as Array<Record<string, unknown>>);
        const report = diagnostics(info);
        await info.attach('somewhere-diagnostics', { body: Buffer.from(JSON.stringify({ ...report, title: titled(info.project.name, scrub(info.title)), errors: info.errors.map(error => describeError(error)), secretAudit: 'issued values scrubbed before reporting' })), contentType: 'application/json' });
      }
    }, { auto: true }],
    newUser: async ({ browser, viewport, isMobile, hasTouch, _preview }, use, info) => {
      if (_preview) return previewNewUser(_preview, { browser, viewport, isMobile, hasTouch }, use, info);
      const linked = loadProjectConfig()?.project_id;
      if (!linked) throw new Error('Run somewhere test from a linked project folder.');
      const projectId: string = linked;
      const client = new ApiClient(getToken());
      const target = await timed(info, 'target snapshot', () => fixtureTestTarget(client, projectId));
      const { origin, host } = target;
      diagnostics(info).release = target.releaseId;
      const owned: IssuedIdentity[] = [];
      const contexts: BrowserContext[] = [];
      const partialIds: string[] = [];
      // Every creation still running when the test ends (say Promise.all rejected on another actor)
      // is waited for before cleanup reads the ids, so a late identity is deleted too.
      const inflight = new Set<Promise<unknown>>();
      try {
        await use((options = {}) => {
          const creation = createUser(options);
          inflight.add(creation);
          void creation.finally(() => inflight.delete(creation)).catch(() => {});
          return creation;
        });
      } finally {
        while (inflight.size) await Promise.allSettled([...inflight]);
        await cleanup();
      }
      async function createUser(options: NewUserOptions): Promise<TestUser> {
          if (options.role !== undefined && (typeof options.role !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(options.role))) throw new Error('newUser({ role }): name a role declared in db/schema.ts appRoles.');
          let created: Awaited<ReturnType<typeof createTestIdentities>>;
          try { created = await timed(info, 'test-user creation', () => createTestIdentities(client, projectId, 'user', 1, 'pw')); }
          catch (error) {
            partialIds.push(...((error as { createdIds?: string[] }).createdIds ?? []));
            owned.push(...((error as { issued?: IssuedIdentity[] }).issued ?? []));
            throw error;
          }
          owned.push(...created.issued);
          const issued = created.issued[0];
          rememberSecrets(issued.access_token, issued.refresh_token);
          const granted = options.role === undefined ? undefined : timed(info, 'role grant', () => client.call('POST', '/auth/app-roles/grant', { project_id: projectId, user_id: issued.user.id, role: options.role }))
            .catch((error: unknown) => { throw new Error(`newUser({ role: '${options.role}' }): the role was not granted: ${error instanceof Error ? scrub(error.message) : String(error)}`); });
          const opened = browser.newContext({ baseURL: origin, viewport, isMobile, hasTouch, extraHTTPHeaders: { Origin: origin }, storageState: buildStorageState(origin, host, issued, expiryOf(issued, created.receivedAt)) })
            .then(context => { contexts.push(context); return context; });
          // Both settle before this creation does: a failed context never leaves a grant running.
          const [openedResult, grantResult] = await Promise.allSettled([opened, granted ?? Promise.resolve()]);
          if (openedResult.status === 'rejected') throw openedResult.reason;
          if (grantResult.status === 'rejected') throw grantResult.reason;
          const context = openedResult.value;
          constrain(context.request, origin, info);
          digests.set(context.request, target.contractDigest);
          const page = waitOnNavigation(await timed(info, 'page creation', () => context.newPage()));
          trackPage(page, titled(info.project.name, info.title));
          page.on('load', () => { void page.evaluate<number>("performance.getEntriesByType('navigation')[0]?.duration ?? 0").then(ms => { diagnostics(info).timings['page load'] = ms; }).catch(() => {}); });
          return { id: issued.user.id, email: issued.user.email, page, request: context.request };
      }
      async function cleanup(): Promise<void> {
        const failures: string[] = [];
        for (const context of contexts) try {
          rememberSecrets(...(await context.cookies()).map(cookie => cookie.value));
          if (info.status !== info.expectedStatus && !diagnostics(info).screenshot) {
            const page = context.pages()[0];
            if (page && await safeToScreenshot(page)) {
              const path = info.outputPath('failure.png');
              await page.screenshot({ path, mask: [page.locator('input, textarea')] });
              diagnostics(info).screenshot = path;
            }
          }
        } catch { failures.push('Failure screenshot capture failed'); }
        const ids = [...new Set([...owned.map(identity => identity.user.id), ...partialIds])];
        // Contexts close while the exact ids are deleted. The DELETE answer names the ids it removed;
        // only when it does not name every one is the list read back to confirm.
        await Promise.all([
          ...contexts.map(context => context.close().catch(() => { failures.push('Browser context cleanup failed'); })),
          ids.length ? (async () => {
            try {
              const deleted = await timed(info, 'test-user deletion', () => client.call<{ ids?: string[] }>('DELETE', '/auth/test-users', { project_id: projectId, ids }));
              if (ids.every(id => deleted.ids?.includes(id))) return;
              const remaining = await timed(info, 'cleanup confirmation', () => client.call<{ identities: { id: string }[] }>('GET', '/auth/test-users', undefined, { project_id: projectId }));
              if (remaining.identities.some(identity => ids.includes(identity.id))) failures.push('Test user cleanup unconfirmed');
            } catch { failures.push('Test user cleanup unconfirmed; app rows remain'); }
          })() : Promise.resolve(),
        ]);
        if (failures.length) throw new Error(failures.join('; '));
      }
    },
    anonymous: async ({ browser, _preview }, use, info) => {
      const projectId = loadProjectConfig()?.project_id;
      if (!projectId) throw new Error('Run from a linked project folder.');
      const target = _preview ? _preview.target : await timed(info, 'target snapshot', () => fixtureTestTarget(new ApiClient(getToken()), projectId));
      const { origin } = target;
      diagnostics(info).release = target.releaseId;
      const context = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
      if (_preview) await _preview.prepareContext(context);
      constrain(context.request, origin, info);
      digests.set(context.request, target.contractDigest);
      try { await use(context.request); } finally { rememberSecrets(...(await context.cookies()).map(cookie => cookie.value)); await context.close(); }
    },
    newPage: async ({ browser, baseURL, viewport, isMobile, hasTouch, _forms, _preview }, use, info) => {
      const contexts: BrowserContext[] = [];
      try {
        await use(async () => {
          const context = await browser.newContext({ baseURL, viewport, isMobile, hasTouch });
          contexts.push(context);
          if (_preview) await _preview.prepareContext(context);
          const page = waitOnNavigation(await context.newPage());
          trackPage(page, titled(info.project.name, info.title));
          _forms.pages.add(page);
          return page;
        });
      } finally {
        for (const context of contexts) await context.close().catch(() => {});
      }
    },
    // Depends on page so its teardown (screenshots, cookie scrubbing) runs while the page is open.
    _forms: async ({ page, _preview }, use, info) => {
      const run = new FormRun(info, _preview);
      trackPage(page, titled(info.project.name, info.title));
      run.pages.add(page);
      try { await use(run); } finally { await run.finish(); }
    },
    signUp: async ({ _forms }, use, info) => { await use((page, options) => span('signUp', { test: titled(info.project.name, info.title) }, () => signUp(_forms, page, options ?? {}))); },
    verify: async ({ _forms }, use, info) => { await use((page, person) => span('verify', { test: titled(info.project.name, info.title) }, () => verify(_forms, page, person))); },
    signIn: async ({ _forms }, use, info) => { await use((page, person, options) => span('signIn', { test: titled(info.project.name, info.title) }, () => signIn(_forms, page, person, options ?? {}))); },
    signOut: async ({ _forms }, use, info) => { await use((page, options) => span('signOut', { test: titled(info.project.name, info.title) }, () => signOut(_forms, page, options ?? {}))); },
  });
  loaded = { test, expect: pw.expect };
  return loaded;
}

/**
 * newUser in a preview run: a managed test user made with the preview's developer tool (its
 * password is returned once and never printed), signed in through the app's own auth route on the
 * preview, and deleted by id at the end. App roles are assigned by the app's own server code in a
 * preview (sw.auth.server.setRoles), so `{ role }` is refused rather than granted some other way.
 */
async function previewNewUser(control: TestControl, args: { browser: import('@playwright/test').Browser; viewport: PlaywrightTestOptions['viewport']; isMobile: boolean; hasTouch: boolean },
  use: (create: (options?: NewUserOptions) => Promise<TestUser>) => Promise<void>, info: TestInfo): Promise<void> {
  const { origin } = control.target;
  diagnostics(info).release = control.target.releaseId;
  const ids: string[] = [];
  const contexts: BrowserContext[] = [];
  const inflight = new Set<Promise<unknown>>();
  const create = async (options: NewUserOptions = {}): Promise<TestUser> => {
    if (options.role !== undefined) {
      throw new Error('newUser({ role }) is not available in a preview: a preview grants roles only through your app\'s own server code (sw.auth.server.setRoles). Sign the person up and let the app grant it, or test the role in production.');
    }
    const user = await timed(info, 'test-user creation', () => control.createManagedUser!());
    ids.push(user.id);
    const context = await args.browser.newContext({ baseURL: origin, viewport: args.viewport, isMobile: args.isMobile, hasTouch: args.hasTouch, extraHTTPHeaders: { Origin: origin } });
    contexts.push(context);
    await control.prepareContext(context);
    const signedIn = await timed(info, 'test-user sign-in', () => context.request.post(origin + '/api/auth/login', { data: { email: user.email, password: user.password }, headers: { Origin: origin }, maxRedirects: 0 }));
    rememberSecrets(...(await context.cookies()).map((cookie) => cookie.value));
    if (!signedIn.ok()) {
      throw new Error(`newUser: the preview test user could not sign in through the app's /api/auth/login (HTTP ${signedIn.status()}). In a preview, newUser signs in through the app's own auth route; an app without one can use signUp(page) and signIn(page, person).`);
    }
    constrain(context.request, origin, info);
    digests.set(context.request, control.target.contractDigest);
    const page = waitOnNavigation(await timed(info, 'page creation', () => context.newPage()));
    trackPage(page, titled(info.project.name, info.title));
    return { id: user.id, email: user.email, page, request: context.request };
  };
  try {
    await use((options) => { const creation = create(options); inflight.add(creation); void creation.finally(() => inflight.delete(creation)).catch(() => {}); return creation; });
  } finally {
    while (inflight.size) await Promise.allSettled([...inflight]);
    const failures: string[] = [];
    for (const context of contexts) {
      try { rememberSecrets(...(await context.cookies()).map((cookie) => cookie.value)); } catch { /* closed */ }
      const page = context.pages()[0];
      if (info.status !== info.expectedStatus && !diagnostics(info).screenshot && page && await safeToScreenshot(page)) {
        try { const path = info.outputPath('failure.png'); await page.screenshot({ path, mask: [page.locator('input, textarea')] }); diagnostics(info).screenshot = path; }
        catch { failures.push('Failure screenshot capture failed'); }
      }
    }
    await Promise.all(contexts.map((context) => context.close().catch(() => { failures.push('Browser context cleanup failed'); })));
    for (const id of ids) {
      const refused = await timed(info, 'test-user deletion', () => control.deleteManagedUser!(id));
      if (refused !== null) failures.push(`Preview test user cleanup unconfirmed (${refused})`);
    }
    if (failures.length) throw new Error(failures.join('; '));
  }
}

/** The value of each cookie a response sets (`name=value; attributes...`), as sent. */
export function setCookieValues(response: Pick<APIResponse, 'headersArray'>): string[] {
  const values: string[] = [];
  for (const header of response.headersArray()) {
    if (header.name.toLowerCase() !== 'set-cookie') continue;
    const pair = header.value.split(';', 1)[0] ?? '';
    const at = pair.indexOf('=');
    const value = at < 0 ? '' : pair.slice(at + 1).trim();
    if (value) values.push(value);
  }
  return values;
}

// Patch the shared-cookie client, preserving its identity and cookie rotation.
function constrain(client: APIRequestContext, origin: string, info: TestInfo): void {
  for (const method of ['fetch'] as const) {
    const original = client[method].bind(client) as (url: string, options?: Record<string, unknown>) => Promise<APIResponse>;
    Object.defineProperty(client, method, { value: async (path: string, options: Record<string, unknown> = {}) => {
      const url = new URL(path, origin);
      if (url.origin !== origin) throw new Error('Fixture requests must stay on the app origin');
      const headers = new Headers(options.headers as Record<string, string> | undefined);
      if (headers.has('Authorization')) throw new Error('Fixture clients do not accept Authorization headers');
      headers.set('Origin', origin);
      const response = await timed(info, 'app requests', () => original(url.href, { ...options, headers: Object.fromEntries(headers), maxRedirects: 0 }));
      // The cookies THIS request set are on its own response (redirects are not followed); remembering them from
      // the Set-Cookie headers costs nothing, where reading the whole jar (storageState) is a round trip to the
      // Playwright driver on every call (~35-40 ms, slow-calls 5.3). Every other cookie in the context is read
      // whole at fixture teardown, before any report is scrubbed.
      rememberSecrets(...setCookieValues(response));
      let code = 'none';
      if (response.status() >= 400) {
        try { const body = await response.json() as { error?: unknown }; if (typeof body.error === 'string' && /^[A-Z_]+$/.test(body.error)) code = body.error; } catch {}
      }
      diagnostics(info).request = { method: String(options.method ?? 'GET').toUpperCase(), path: scrub(url.pathname), status: response.status(), code };
      timelineMark('app-request', { test: titled(info.project.name, info.title), method: String(options.method ?? 'GET').toUpperCase(), path: scrub(url.pathname), status: response.status() });
      return response;
    } });
  }
}

// Export Playwright's own test object whenever the project can load it: Playwright records a test's
// file from the frame that calls test(), so a forwarding wrapper would place every test in this file
// and `somewhere test <file>` would match none. The lazy wrapper remains only for plain Node imports
// without @playwright/test, where test() is never called.
const eager = (() => { try { return runner(); } catch { return undefined; } })();
if (eager) { markProcessStart('playwright'); timelineMark('fixtures:loaded'); }
export const test: RunnerTest = eager?.test ?? new Proxy((() => {}) as unknown as RunnerTest, {
  apply: (_target, receiver, args) => Reflect.apply(runner().test, receiver, args),
  get: (_target, key) => Reflect.get(runner().test, key),
});
export const expect: typeof import('@playwright/test').expect = eager?.expect ?? new Proxy((() => {}) as unknown as typeof import('@playwright/test').expect, {
  apply: (_target, receiver, args) => Reflect.apply(runner().expect, receiver, args),
  get: (_target, key) => Reflect.get(runner().expect, key),
});
type Person_ = Page | { request: APIRequestContext } | APIRequestContext;
/** `allowed`: someone the same request succeeds for. It is the positive control that turns an
 *  empty list, a null get or a 404 into proof of refusal (otherwise those look exactly like an
 *  empty table, a missing row or a missing route). */
export interface RefusalOptions { allowed?: Person_ }
/**
 * Prove a refusal: act as `person` against a table (with a data request) or an endpoint
 * ('METHOD /path', with a JSON body), and pass only if it was refused.
 * - 401 or 403 counts as refused on its own.
 * - A 200 with no rows, a get with data:null, or a 404 counts only with `{ allowed }`: the same
 *   read must return data for them, the row a write targeted must exist for them before and be
 *   unchanged after, and an endpoint must succeed for them.
 * - A malformed request or a stale contract (400/409) never counts.
 * With `allowed`, the control always runs (after the person's attempt), so an endpoint call
 * runs twice. The older form expectRefused(response, status, code) checks one exact status and code.
 */
export async function expectRefused(person: Person_, target: string, request?: unknown, options?: RefusalOptions): Promise<void>;
export async function expectRefused(response: APIResponse, status: number, code: string): Promise<void>;
export async function expectRefused(first: APIResponse | Person_, second: number | string, third?: unknown, options?: RefusalOptions): Promise<void> {
  if (typeof second === 'string') return refusedAs(first as Person_, second, third, options ?? {});
  const response = first as APIResponse;
  const status = second, code = third as string;
  const actual = response.status();
  if ([400, 409].includes(actual) || [400, 409].includes(status)) throw new Error(`HTTP ${actual}: malformed request or contract mismatch proves no access refusal`);
  const body = await response.json() as { error?: unknown };
  if (actual !== status || body.error !== code) throw new Error(`Expected HTTP ${status} ${code}; received HTTP ${actual} ${typeof body.error === 'string' && /^[A-Z_]+$/.test(body.error) ? body.error : 'unknown error code'}`);
}
function clientOf(person: Person_): APIRequestContext {
  if (typeof (person as Page).context === 'function' && typeof (person as Page).goto === 'function') return (person as Page).context().request;
  if ('request' in person && typeof (person as { request: APIRequestContext }).request?.post === 'function' && typeof (person as unknown as APIRequestContext).fetch !== 'function') return (person as { request: APIRequestContext }).request;
  return person as APIRequestContext;
}
const ENDPOINT = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;
async function bodyOf(response: APIResponse): Promise<{ code: string; message: string; json: Record<string, unknown> | null }> {
  let json: Record<string, unknown> | null = null;
  try { json = await response.json() as Record<string, unknown>; } catch { /* not JSON */ }
  const raw = typeof json?.error === 'string' ? json.error : '';
  return { code: /^[A-Z_]+$/.test(raw) ? raw : 'none', message: typeof json?.message === 'string' ? scrub(json.message).slice(0, 300) : '', json };
}
const INCONCLUSIVE = 'looks the same as an empty table, a missing row or a missing route, so it proves nothing on its own. Pass { allowed: <someone the same request succeeds for> } as the positive control.';
function seen(status: number, code: string, message: string): string {
  const kind = status === 400 ? 'a malformed request' : status === 409 ? 'a stale data contract' : `HTTP ${status}`;
  return `${kind} (${status} ${code}${message ? `: ${message}` : ''})`;
}
async function refusedAs(person: Person_, target: string, request: unknown, options: RefusalOptions): Promise<void> {
  const client = clientOf(person);
  const allowed = options.allowed === undefined ? undefined : clientOf(options.allowed);
  const endpoint = ENDPOINT.exec(target);
  if (endpoint) {
    const [, method, path] = endpoint;
    const send = (as: APIRequestContext) => as.fetch(path, { method, ...(method === 'GET' || request === undefined ? {} : { data: request }) });
    const response = await send(client);
    const status = response.status();
    const { code, message } = await bodyOf(response);
    const said = `${target} answered ${seen(status, code, message)}`;
    if (status < 400) throw new Error(`expectRefused: ${said}: it was allowed, not refused.`);
    if (status === 400 || status === 422) throw new Error(`expectRefused: ${said}: the endpoint rejected the input, which says nothing about who is asking. Send a body it accepts from someone who may.`);
    if (![401, 403, 404].includes(status)) throw new Error(`expectRefused: ${said}: a refusal is 401, 403 or 404.`);
    if (status === 404 && !allowed) throw new Error(`expectRefused: ${said}: a 404 ${INCONCLUSIVE}`);
    if (allowed) {
      const control = await send(allowed);
      const c = await bodyOf(control);
      if (control.status() >= 300) throw new Error(`expectRefused: ${said}, but the allowed person got ${seen(control.status(), c.code, c.message)} too, so the route or input is wrong and the refusal is not proven.`);
    }
    return;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) throw new Error(`expectRefused: "${target}" is neither a table name nor 'METHOD /path'.`);
  if (!request || typeof request !== 'object' || typeof (request as { operation?: unknown }).operation !== 'string') {
    throw new Error(`expectRefused: pass a data request for table ${target}, for example { operation: 'get', id }.`);
  }
  for (const as of [client, ...(allowed ? [allowed] : [])]) {
    if (!digests.has(as)) throw new Error('expectRefused: act as (and pass allowed as) a page that signed up or signed in (signUp/signIn), a newUser() user, or anonymous.');
  }
  const operation = (request as { operation: string }).operation;
  const reading = operation === 'get' || operation === 'list' || operation === 'relation_list';
  const writing = operation === 'update' || operation === 'delete';
  const id = (request as { id?: string | number }).id;
  const rowOf = async (as: APIRequestContext) => {
    const response = await data(as, target, { operation: 'get', id: id as string | number });
    const body = await bodyOf(response);
    if (response.status() !== 200) throw new Error(`expectRefused: the allowed person could not read ${target} ${String(id)} (${seen(response.status(), body.code, body.message)}), so it is not a control for this row.`);
    return body.json?.data ?? null;
  };
  let before = '';
  if (writing && allowed) {
    const row = await rowOf(allowed);
    before = JSON.stringify(row);
    if (row === null) throw new Error(`expectRefused: ${target} ${String(id)} does not exist for the allowed person, so there is nothing to refuse. Create the row first.`);
  }
  const response = await data(client, target, request as DataRequest);
  const status = response.status();
  const { code, message, json } = await bodyOf(response);
  const said = `${operation} on ${target} answered ${seen(status, code, message)}`;
  const { kind } = classifyData(status, json, operation);
  if (kind === 'missing-contract' || kind === 'stale-contract' || kind === 'malformed') {
    throw new Error(`expectRefused: ${said}. Nothing ran, so this proves nothing about access.`);
  }
  const rows = json?.data;
  const empty = status === 200 && ((operation === 'get' && rows === null) || ((operation === 'list' || operation === 'relation_list') && Array.isArray(rows) && rows.length === 0));
  const missing = kind === 'missing-or-refused';
  if (status === 200 && !empty) {
    if (reading) throw new Error(`expectRefused: ${said}: this person read ${Array.isArray(rows) ? `${rows.length} row(s)` : 'the row'}.`);
    throw new Error(`expectRefused: ${said}: the ${operation} was allowed.`);
  }
  if (kind !== 'refused' && !empty && !missing) throw new Error(`expectRefused: ${said}: not a refusal.`);
  if ((empty || missing) && !allowed) throw new Error(`expectRefused: ${said}: ${empty ? 'an empty answer' : 'a 404'} ${INCONCLUSIVE}`);
  if (!allowed) return;
  if (reading) {
    const control = await data(allowed, target, request as DataRequest);
    const c = await bodyOf(control);
    const got = c.json?.data;
    const found = control.status() === 200 && (operation === 'get' ? got !== null && got !== undefined : Array.isArray(got) && got.length > 0);
    if (!found) throw new Error(`expectRefused: ${said}, but the allowed person got ${control.status() === 200 ? 'nothing' : seen(control.status(), c.code, c.message)} for the same request, so there was nothing to refuse.`);
  } else if (writing) {
    const after = await rowOf(allowed);
    if (JSON.stringify(after) !== before) throw new Error(`expectRefused: ${said}, but ${target} ${String(id)} ${after === null ? 'is gone' : 'changed'} for the allowed person afterwards.`);
  }
}
/** Test seam: a stand-in request client that data() accepts. */
export function _fixtureClientForTests(client: APIRequestContext, digest: string): APIRequestContext { digests.set(client, digest); return client; }
export function data(client: APIRequestContext, table: string, request: DataRequest): Promise<APIResponse> {
  if (!digests.has(client)) throw new Error('Use a newUser or anonymous fixture client');
  return client.post('/__sw/data', { data: { ...request, table, contract: digests.get(client) ?? '' } });
}
export { ready };

// ---------------------------------------------------------------- sign-up through the app's form
//
// The form lifecycle lives in form-auth.ts (shared with plain scripts, src/script.ts). This fixture
// supplies its test's timing, timeout and failure screenshots, and attaches the data client.

const constrained = new WeakSet<APIRequestContext>();

class FormRun implements FormHost {
  readonly pages = new Set<Page>();
  readonly attempts: Attempt[] = [];
  private loading?: Promise<FormControl>;
  private readonly prepared = new WeakSet<BrowserContext>();
  readonly root = process.cwd();
  constructor(readonly info: TestInfo, private readonly preview: TestControl | null) {}
  timed<T>(name: string, work: () => Promise<T>): Promise<T> { return timed(this.info, name, work); }
  control(): Promise<FormControl> {
    return this.loading ??= (async () => {
      // A preview run uses its worker's preview control; only a production run reads your sign-in.
      const control = this.preview ?? await timed(this.info, 'target snapshot', async () => {
        const projectId = linkedProject();
        return openProductionControl(projectId, runTarget(projectId) ?? undefined);
      });
      diagnostics(this.info).release = control.target.releaseId;
      return { control };
    })();
  }
  async prepare(page: Page): Promise<void> {
    if (!this.preview || this.prepared.has(page.context())) return;
    this.prepared.add(page.context());
    await this.preview.prepareContext(page.context());
  }
  /** The page's own request client, with the app Origin and the data contract, for data()/expectRefused(). */
  async attach(page: Page): Promise<void> {
    this.pages.add(page);
    const { target } = (await this.control()).control;
    const request = page.context().request;
    if (constrained.has(request)) return;
    constrained.add(request);
    constrain(request, target.origin, this.info);
    digests.set(request, target.contractDigest);
  }
  /** Email codes travel by real mail paths; give each auth step room inside the test's timeout. */
  allowTime(ms: number): void { if (this.info.timeout > 0) this.info.setTimeout(this.info.timeout + ms); }
  async finish(): Promise<void> {
    const failures: string[] = [];
    const failed = this.info.status !== this.info.expectedStatus;
    for (const page of this.pages) {
      if (page.isClosed()) continue;
      try { rememberSecrets(...(await page.context().cookies()).map(cookie => cookie.value)); } catch { /* context already closed */ }
      if (failed && !diagnostics(this.info).screenshot && await safeToScreenshot(page)) try {
        const path = this.info.outputPath('failure.png');
        await page.screenshot({ path, mask: [page.locator('input, textarea')] });
        diagnostics(this.info).screenshot = path;
      } catch { failures.push('Failure screenshot capture failed'); }
    }
    // This test's accounts are deleted together by their exact ids, with the teams only they belong to.
    const withIds = this.attempts.filter(attempt => attempt.id);
    if (withIds.length) {
      const { control } = await this.control();
      const deletion = await timed(this.info, 'sign-up account deletion', () => control.deleteSignups([...new Set(withIds.map(attempt => attempt.id!))]));
      for (const attempt of withIds) {
        const id = attempt.id!;
        if (deletion.done.includes(id)) forgetRecord(attempt.record);
        else if (deletion.dropped.has(id)) {
          // Not a cleanup failure: there is nothing left to delete (the run fails for the closed preview itself).
          forgetRecord(attempt.record);
          (diagnostics(this.info).notes ??= []).push(`Dropped the cleanup record of ${attempt.email}: ${deletion.dropped.get(id)}.`);
        } else failures.push(`Could not delete the form sign-up account ${attempt.email} (${deletion.kept.get(id) ?? 'not deleted'}); its record is kept and the next somewhere test retries`);
      }
      if (deletion.teamsDeleted.length) (diagnostics(this.info).notes ??= []).push(`Deleted ${deletion.teamsDeleted.length} team(s) that only this test's sign-ups belonged to: ${deletion.teamsDeleted.map(team => `"${team.name}" (${team.id})`).join(', ')}.`);
    }
    for (const attempt of this.attempts.filter(attempt => !attempt.id)) {
      if (attempt.submitted && !attempt.refused) {
        // Never delete by address: the account may exist, but this run never learned its id.
        failures.push(`A sign-up for ${attempt.email} was submitted but no account id came back, so nothing was deleted; if it exists, delete it from the project's users list`);
      }
      forgetRecord(attempt.record);
    }
    if (failures.length) throw new Error(failures.join('; '));
  }
}

