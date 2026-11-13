import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { APIRequestContext, APIResponse, BrowserContext, Locator, Page, TestType, PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions } from '@playwright/test';
import { fixtureTestTarget } from './test-target.js';
import { ApiClient } from './client.js';
import { getToken, loadProjectConfig } from './config.js';
import { buildStorageState, createTestIdentities, expiryOf, messagesAfter, type IssuedIdentity, type InboxMessage } from './test-identities.js';
import { diagnostics, rememberSecrets, scrub, describeError, timed } from './test-diagnostics.js';
import { admitReservedAddress, deleteAccount, forgetRecord, generatedAddress, generatedPassword, recordAttempt, recordId } from './form-accounts.js';
import type { TestTarget } from './test-target.js';
import type { TestInfo } from '@playwright/test';
import type { DataRequest } from '../testing.js';

export interface TestUser { id: string; email: string; page: Page; request: APIRequestContext }
/** An ordinary account made through the app's own sign-up form. `verified` is true once its
 *  address was verified with a captured code (verify(), or a project that requires email codes). */
export interface Person { id: string; email: string; password: string; verified: boolean }
/** Your own form steps, for an app that replaced the starter's form. */
export type FormSteps = (page: Page, input: { email: string; password: string }) => Promise<void>;
/** Your own steps to enter an emailed sign-in code. */
export type CodeSteps = (page: Page, code: string) => Promise<void>;
export interface SignUpOptions { domain?: string; email?: string; steps?: FormSteps; codeSteps?: CodeSteps }
export interface SignInOptions { steps?: FormSteps; codeSteps?: CodeSteps }
interface Fixtures {
  _evidence: void; newUser: () => Promise<TestUser>; anonymous: APIRequestContext; _forms: FormRun;
  signUp: (page: Page, options?: SignUpOptions) => Promise<Person>;
  verify: (page: Page, person: Person) => Promise<void>;
  signIn: (page: Page, person: Person, options?: SignInOptions) => Promise<void>;
  signOut: (page: Page, options?: { steps?: (page: Page) => Promise<void> }) => Promise<void>;
}
type RunnerTest = TestType<PlaywrightTestArgs & PlaywrightTestOptions & Fixtures, PlaywrightWorkerArgs & PlaywrightWorkerOptions>;
let loaded: { test: RunnerTest; expect: typeof import('@playwright/test').expect } | undefined;
const digests = new WeakMap<APIRequestContext, string | null>();

function runner() {
  if (loaded) return loaded;
  const require = createRequire(join(process.cwd(), 'package.json'));
  let pw: typeof import('@playwright/test');
  try { pw = require('@playwright/test') as typeof import('@playwright/test'); }
  catch { throw new Error('Install project test dependencies: npm install -D @playwright/test @somewhere-cloud/cli'); }
  const test = pw.test.extend<Fixtures>({
    _evidence: [async ({}, use, info) => {
      try { await use(); } finally {
        const report = diagnostics(info);
        await info.attach('somewhere-diagnostics', { body: Buffer.from(JSON.stringify({ ...report, title: scrub(info.title), errors: info.errors.map(error => describeError(error)), secretAudit: 'issued values scrubbed before reporting' })), contentType: 'application/json' });
      }
    }, { auto: true }],
    newUser: async ({ browser }, use, info) => {
      const projectId = loadProjectConfig()?.project_id;
      if (!projectId) throw new Error('Run somewhere test from a linked project folder.');
      const client = new ApiClient(getToken());
      const target = await timed(info, 'target snapshot', () => fixtureTestTarget(client, projectId));
      const { origin, host } = target;
      diagnostics(info).release = target.releaseId;
      const owned: IssuedIdentity[] = [];
      const contexts: BrowserContext[] = [];
      const partialIds: string[] = [];
      try {
        await use(async () => {
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
          const context = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin }, storageState: buildStorageState(origin, host, issued, expiryOf(issued, created.receivedAt)) });
          contexts.push(context);
          constrain(context.request, origin, info);
          digests.set(context.request, target.contractDigest);
          const page = await timed(info, 'page creation', () => context.newPage());
          page.on('load', () => { void page.evaluate<number>("performance.getEntriesByType('navigation')[0]?.duration ?? 0").then(ms => { diagnostics(info).timings['page load'] = ms; }).catch(() => {}); });
          return { id: issued.user.id, email: issued.user.email, page, request: context.request };
        });
      } finally {
        const failures: string[] = [];
        for (const context of contexts) try {
          rememberSecrets(...(await context.cookies()).map(cookie => cookie.value));
          if (info.status !== info.expectedStatus) {
            const page = context.pages()[0];
            if (page && !/auth|login|signup|reset/i.test(new URL(page.url()).pathname)) {
              const path = info.outputPath('failure.png');
              await page.screenshot({ path, mask: [page.locator('input, textarea')] });
              diagnostics(info).screenshot = path;
            }
          }
        } catch { failures.push('Failure screenshot capture failed'); } finally {
          try { await context.close(); } catch { failures.push('Browser context cleanup failed'); }
        }
        const ids = [...new Set([...owned.map(identity => identity.user.id), ...partialIds])];
        if (ids.length) {
          try {
            await timed(info, 'test-user deletion', () => client.call('DELETE', '/auth/test-users', { project_id: projectId, ids }));
            const remaining = await timed(info, 'cleanup confirmation', () => client.call<{ identities: { id: string }[] }>('GET', '/auth/test-users', undefined, { project_id: projectId }));
            if (remaining.identities.some(identity => ids.includes(identity.id))) failures.push('Test user cleanup unconfirmed');
          } catch { failures.push('Test user cleanup unconfirmed; app rows remain'); }
        }
        if (failures.length) throw new Error(failures.join('; '));
      }
    },
    anonymous: async ({ browser }, use, info) => {
      const projectId = loadProjectConfig()?.project_id;
      if (!projectId) throw new Error('Run from a linked project folder.');
      const client = new ApiClient(getToken());
      const target = await timed(info, 'target snapshot', () => fixtureTestTarget(client, projectId));
      const { origin } = target;
      diagnostics(info).release = target.releaseId;
      const context = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
      constrain(context.request, origin, info);
      digests.set(context.request, target.contractDigest);
      try { await use(context.request); } finally { rememberSecrets(...(await context.cookies()).map(cookie => cookie.value)); await context.close(); }
    },
    // Depends on page so its teardown (screenshots, cookie scrubbing) runs while the page is open.
    _forms: async ({ page }, use, info) => {
      const run = new FormRun(info);
      run.pages.add(page);
      try { await use(run); } finally { await run.finish(); }
    },
    signUp: async ({ _forms }, use) => { await use((page, options) => signUp(_forms, page, options ?? {})); },
    verify: async ({ _forms }, use) => { await use((page, person) => verify(_forms, page, person)); },
    signIn: async ({ _forms }, use) => { await use((page, person, options) => signIn(_forms, page, person, options ?? {})); },
    signOut: async ({ _forms }, use) => { await use((page, options) => signOut(_forms, page, options ?? {})); },
  });
  loaded = { test, expect: pw.expect };
  return loaded;
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
      rememberSecrets(...(await client.storageState()).cookies.map(cookie => cookie.value));
      let code = 'none';
      if (response.status() >= 400) {
        try { const body = await response.json() as { error?: unknown }; if (typeof body.error === 'string' && /^[A-Z_]+$/.test(body.error)) code = body.error; } catch {}
      }
      diagnostics(info).request = { method: String(options.method ?? 'GET').toUpperCase(), path: scrub(url.pathname), status: response.status(), code };
      return response;
    } });
  }
}

// Export Playwright's own test object whenever the project can load it: Playwright records a test's
// file from the frame that calls test(), so a forwarding wrapper would place every test in this file
// and `somewhere test <file>` would match none. The lazy wrapper remains only for plain Node imports
// without @playwright/test, where test() is never called.
const eager = (() => { try { return runner(); } catch { return undefined; } })();
export const test: RunnerTest = eager?.test ?? new Proxy((() => {}) as unknown as RunnerTest, {
  apply: (_target, receiver, args) => Reflect.apply(runner().test, receiver, args),
  get: (_target, key) => Reflect.get(runner().test, key),
});
export const expect: typeof import('@playwright/test').expect = eager?.expect ?? new Proxy((() => {}) as unknown as typeof import('@playwright/test').expect, {
  apply: (_target, receiver, args) => Reflect.apply(runner().expect, receiver, args),
  get: (_target, key) => Reflect.get(runner().expect, key),
});
export async function expectRefused(response: APIResponse, status: number, code: string): Promise<void> {
  const actual = response.status();
  if ([400, 409].includes(actual) || [400, 409].includes(status)) throw new Error(`HTTP ${actual}: malformed request or contract mismatch proves no access refusal`);
  const body = await response.json() as { error?: unknown };
  if (actual !== status || body.error !== code) throw new Error(`Expected HTTP ${status} ${code}; received HTTP ${actual} ${typeof body.error === 'string' && /^[A-Z_]+$/.test(body.error) ? body.error : 'unknown error code'}`);
}
export function data(client: APIRequestContext, table: string, request: DataRequest): Promise<APIResponse> {
  if (!digests.has(client)) throw new Error('Use a newUser or anonymous fixture client');
  return client.post('/__sw/data', { data: { ...request, table, contract: digests.get(client) ?? '' } });
}
export async function ready(page: Page, state: 'ready' | 'signed-in' | 'signed-out' | Locator = 'ready'): Promise<void> {
  const locator = typeof state === 'string' ? page.locator(state === 'ready' ? '[data-app-state="signed-in"], [data-app-state="signed-out"]' : `[data-app-state="${state}"]`) : state;
  await locator.waitFor({ state: 'visible' });
}

// ---------------------------------------------------------------- sign-up through the app's form
//
// signUp/verify/signIn/signOut drive the app's own pages. The developer credential stays in this
// process and is used only on the control plane: to read the captured code for the exact address
// (GET /email/test-inbox) and to delete the exact account ids this test created. The browser and
// the app only ever see the person's own email, password and code, typed into the app's form.

const COMPLETED = 'signed-in';
const constrained = new WeakSet<APIRequestContext>();
const marks = new WeakMap<Person, InboxMark>();
interface InboxMark { seen: Set<string>; since: number }
interface Attempt { email: string; record: string; id: string | null; submitted: boolean; refused: boolean }
interface Control { client: ApiClient; projectId: string; target: TestTarget }

class FormRun {
  readonly pages = new Set<Page>();
  readonly attempts: Attempt[] = [];
  private loading?: Promise<Control>;
  constructor(readonly info: TestInfo) {}
  control(): Promise<Control> {
    return this.loading ??= (async () => {
      const projectId = loadProjectConfig()?.project_id;
      if (!projectId) throw new Error('Run somewhere test from a linked project folder.');
      const client = new ApiClient(getToken());
      const target = await timed(this.info, 'target snapshot', () => fixtureTestTarget(client, projectId));
      diagnostics(this.info).release = target.releaseId;
      return { client, projectId, target };
    })();
  }
  /** The page's own request client, with the app Origin and the data contract, for data()/expectRefused(). */
  async attach(page: Page): Promise<void> {
    this.pages.add(page);
    const { target } = await this.control();
    const request = page.context().request;
    if (constrained.has(request)) return;
    constrained.add(request);
    constrain(request, target.origin, this.info);
    digests.set(request, target.contractDigest);
  }
  /** Email codes travel by real mail paths; give each auth step room inside the test's timeout. */
  allowTime(): void { if (this.info.timeout > 0) this.info.setTimeout(this.info.timeout + 20_000); }
  async finish(): Promise<void> {
    const failures: string[] = [];
    const failed = this.info.status !== this.info.expectedStatus;
    for (const page of this.pages) {
      if (page.isClosed()) continue;
      try { rememberSecrets(...(await page.context().cookies()).map(cookie => cookie.value)); } catch { /* context already closed */ }
      if (failed && !diagnostics(this.info).screenshot) try {
        const path = this.info.outputPath('failure.png');
        await page.screenshot({ path, mask: [page.locator('input, textarea')] });
        diagnostics(this.info).screenshot = path;
      } catch { failures.push('Failure screenshot capture failed'); }
    }
    for (const attempt of this.attempts) {
      if (attempt.id) {
        const { client, projectId } = await this.control();
        const id = attempt.id;
        if (await timed(this.info, 'sign-up account deletion', () => deleteAccount(client, projectId, id))) forgetRecord(attempt.record);
        else failures.push(`Could not delete the form sign-up account ${attempt.email}; its record is kept and the next somewhere test retries`);
      } else if (attempt.submitted && !attempt.refused) {
        // Never delete by address: the account may exist, but this run never learned its id.
        failures.push(`A sign-up for ${attempt.email} was submitted but no account id came back, so nothing was deleted; if it exists, delete it from the project's users list`);
        forgetRecord(attempt.record);
      } else forgetRecord(attempt.record);
    }
    if (failures.length) throw new Error(failures.join('; '));
  }
}

class StepError extends Error {}
const hook = (page: Page, name: string) => page.locator(`[data-sw-auth="${name}"]`);

async function pageSays(page: Page): Promise<string> {
  if (page.isClosed()) return '';
  try {
    const text = await page.locator('[data-sw-auth="error"], [role="alert"]').first().textContent({ timeout: 500 });
    return scrub((text ?? '').trim()).slice(0, 300);
  } catch { return ''; }
}

/** Run one named step; a failure says which step, what the page showed, and the cause, scrubbed. */
async function step<T>(page: Page, name: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof StepError) throw error;
    const said = await pageSays(page);
    const cause = scrub(error instanceof Error ? error.message : String(error)).slice(0, 600);
    throw new StepError(`${name} failed${said ? `; the page says "${said}"` : ''}: ${cause}`);
  }
}

/** The starter's form (data-sw-auth hooks), in the wanted mode, on a signed-out page. */
async function openStarterForm(page: Page, mode: 'sign-up' | 'sign-in'): Promise<void> {
  await page.goto('/');
  await ready(page);
  if (await page.locator(`[data-app-state="${COMPLETED}"]`).count()) throw new Error('this page is already signed in; call signOut(page) first or use another page');
  const form = hook(page, 'form');
  if (!(await form.count())) throw new Error('the starter sign-in form (data-sw-auth hooks) is not on this page; pass { steps } with your own form steps');
  if ((await form.getAttribute('data-sw-auth-mode')) !== mode) {
    await hook(page, 'mode').click();
    await page.locator(`[data-sw-auth="form"][data-sw-auth-mode="${mode}"]`).waitFor();
  }
}
async function fillStarterForm(page: Page, input: { email: string; password: string }): Promise<void> {
  await hook(page, 'email').fill(input.email);
  await hook(page, 'password').fill(input.password);
  await hook(page, 'submit').click();
}
async function enterStarterCode(page: Page, code: string): Promise<void> {
  await hook(page, 'mfa-code').fill(code);
  await hook(page, 'mfa-submit').click();
}

interface AuthOutcome { ok: boolean; status: number; code: string; id: string | null; mfa: boolean }
/** The app's own auth response (the packaged /api/auth route or any route ending the same way). */
function authResponse(page: Page, origin: string, suffix: string): Promise<APIResponse | Error> {
  return page.waitForResponse((response) => {
    if (response.request().method() !== 'POST') return false;
    const url = new URL(response.url());
    return url.origin === origin && url.pathname.endsWith(suffix);
  }, { timeout: 30_000 }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))) as Promise<APIResponse | Error>;
}
async function outcome(pending: Promise<APIResponse | Error>, what: string): Promise<AuthOutcome> {
  const response = await pending;
  if (response instanceof Error) throw new Error(`no ${what} response from the app within 30 s (${scrub(response.message.split('\n')[0])})`);
  let body: Record<string, unknown> | null = null;
  try { body = await response.json() as Record<string, unknown>; } catch { /* not JSON */ }
  const data = (body?.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown> | null;
  const user = data?.user as { id?: unknown } | undefined;
  const raw = typeof body?.error === 'string' ? body.error : typeof body?.code === 'string' ? body.code : '';
  return { ok: response.ok(), status: response.status(), code: /^[A-Z_]+$/.test(raw) ? raw : 'none',
    id: typeof user?.id === 'string' && user.id ? user.id : null, mfa: data?.mfa_required === true };
}

async function inbox(run: FormRun, address: string, wait?: { since: number; ms?: number }): Promise<InboxMessage[]> {
  const { client, projectId } = await run.control();
  const body = await timed(run.info, 'test inbox', () => client.call<{ messages?: unknown }>('GET', '/email/test-inbox', undefined,
    { project_id: projectId, address, limit: 20, ...(wait ? { wait_ms: wait.ms ?? 10_000, since: wait.since } : {}) }));
  return messagesAfter(body.messages, address, 0);
}
/** What the test inbox already holds for this address, so a code is only ever one sent after this point. */
async function inboxMark(run: FormRun, address: string): Promise<InboxMark> {
  const messages = await inbox(run, address);
  return { seen: new Set(messages.map(message => message.id)), since: Math.max(0, ...messages.map(message => Date.parse(message.created_at))) };
}
/** Codes in messages to exactly this address that arrived after the mark, newest first, consumed
 *  from the mark. One long-poll of at most `ms`. */
async function takeCodes(run: FormRun, address: string, mark: InboxMark, ms: number): Promise<string[]> {
  const fresh = (await inbox(run, address, { since: mark.since, ms })).filter(message => !mark.seen.has(message.id));
  for (const message of fresh) { mark.seen.add(message.id); mark.since = Math.max(mark.since, Date.parse(message.created_at)); }
  const codes = fresh.flatMap(message => message.verification_code ? [message.verification_code] : []);
  rememberSecrets(...codes);
  return codes;
}
/** Like takeCodes, waiting up to 25 s for at least one. */
async function freshCodes(run: FormRun, address: string, mark: InboxMark, what: string): Promise<string[]> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const codes = await takeCodes(run, address, mark, 10_000);
    if (codes.length) return codes;
    if (Date.now() > deadline) throw new Error(`${what}: no code reached the project's test inbox for ${address} within 25 s. The test inbox holds at most a limited number of messages for 7 days; when it is full, new mail is not stored.`);
  }
}

async function signUp(run: FormRun, page: Page, options: SignUpOptions): Promise<Person> {
  if (options.domain !== undefined && options.email !== undefined) throw new Error('signUp: pass domain or email, not both.');
  const email = options.email !== undefined ? admitReservedAddress(options.email) : generatedAddress(options.domain);
  const password = generatedPassword();
  rememberSecrets(password);
  run.allowTime();
  run.pages.add(page);
  const { target, projectId } = await run.control();
  const mark = await inboxMark(run, email);
  const attempt: Attempt = { email, record: recordAttempt(process.cwd(), projectId, email), id: null, submitted: false, refused: false };
  run.attempts.push(attempt);
  const onRequest = (request: { method(): string; url(): string }) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/auth/signup')) attempt.submitted = true;
  };
  page.on('request', onRequest);
  const signedUp = authResponse(page, target.origin, '/auth/signup');
  try {
    await step(page, 'signUp: fill and submit the sign-up form', async () => {
      if (options.steps) await options.steps(page, { email, password });
      else { await openStarterForm(page, 'sign-up'); await fillStarterForm(page, { email, password }); }
    });
    const result = await step(page, 'signUp: wait for the sign-up response', () => outcome(signedUp, 'sign-up'));
    if (!result.ok) {
      // Only "already registered" proves nothing was created. Any other failure can come after the
      // platform committed the account (the app's own route failing late), so it is reported at
      // cleanup as possibly existing, never assumed absent and never deleted by address.
      const exists = result.status === 409 || result.code === 'AUTH_EMAIL_EXISTS';
      attempt.refused = exists;
      const said = await pageSays(page);
      throw new StepError(exists
        ? `signUp: ${email} is already registered in this project. signUp never uses, resets or deletes an existing account; choose another address.`
        : `signUp: the app answered the sign-up with HTTP ${result.status} ${result.code}${said ? `; the page says "${said}"` : ''}`);
    }
    let id = result.id;
    let verified = false;
    if (result.mfa) {
      // The project requires emailed sign-in codes: the first code goes to the new address, and
      // entering it verifies that address and signs the person in.
      const [code] = await step(page, 'signUp: read the emailed sign-up code', () => freshCodes(run, email, mark, 'signUp'));
      const challenged = authResponse(page, target.origin, '/auth/mfa/challenge');
      await step(page, 'signUp: enter the emailed sign-up code', () => (options.codeSteps ?? enterStarterCode)(page, code));
      const done = await step(page, 'signUp: wait for the code step response', () => outcome(challenged, 'sign-up code'));
      if (!done.ok) throw new StepError(`signUp: the app refused the emailed code (HTTP ${done.status} ${done.code})`);
      id = done.id;
      verified = true;
    }
    if (!id) throw new StepError('signUp: the sign-up succeeded but its response carried no account id, so the account cannot be cleaned up by id');
    attempt.id = id;
    recordId(attempt.record, id);
    if (!options.steps) await step(page, 'signUp: wait for the signed-in page', () => ready(page, 'signed-in'));
    await run.attach(page);
    const person: Person = { id, email, password, verified };
    marks.set(person, mark);
    return person;
  } finally { page.off('request', onRequest); }
}

async function verify(run: FormRun, page: Page, person: Person): Promise<void> {
  run.allowTime();
  await run.attach(page);
  const mark = marks.get(person) ?? await inboxMark(run, person.email);
  // A code the project sent at sign-up is used if it is already there (or arrives within 2 s);
  // otherwise ask the app for one, as its own verify-email step does.
  let codes = await step(page, 'verify: read a code sent at sign-up', () => takeCodes(run, person.email, mark, 2_000));
  if (!codes.length) {
    const sent = await step(page, 'verify: ask the app to email a code', () => page.request.post('/api/auth/request-email-verification', { data: {} }));
    if (!sent.ok()) throw new StepError(`verify: the app did not send a code (HTTP ${sent.status()} ${await errorCode(sent)})`);
    codes = await step(page, 'verify: read the emailed code', () => freshCodes(run, person.email, mark, 'verify'));
  }
  let last = '';
  for (const code of codes) {
    // The platform stores the captured message just before it installs the code, so for a moment
    // the code can read as "no pending verification" (404). Only that answer is retried, briefly;
    // a wrong or expired code (401/400) is never retried.
    let confirmed = await step(page, 'verify: enter the code in the app', () => page.request.post('/api/auth/verify-email', { data: { code } }));
    for (let wait = 0; confirmed.status() === 404 && wait < 8; wait++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      confirmed = await step(page, 'verify: enter the code in the app', () => page.request.post('/api/auth/verify-email', { data: { code } }));
    }
    if (confirmed.ok()) {
      const state = await page.request.get('/api/auth/verify-email');
      if (state.ok() && (await state.json() as { email_verified?: unknown }).email_verified === true) { person.verified = true; return; }
      throw new StepError(`verify: the app accepted the code but still reports ${person.email} as unverified (HTTP ${state.status()})`);
    }
    last = `HTTP ${confirmed.status()} ${await errorCode(confirmed)}`;
  }
  throw new StepError(`verify: the app refused the emailed code (${last})`);
}

async function errorCode(response: APIResponse): Promise<string> {
  try { const body = await response.json() as { error?: unknown }; return typeof body.error === 'string' && /^[A-Z_]+$/.test(body.error) ? body.error : 'none'; } catch { return 'none'; }
}

async function signIn(run: FormRun, page: Page, person: Person, options: SignInOptions): Promise<void> {
  rememberSecrets(person.password);
  run.allowTime();
  run.pages.add(page);
  const { target } = await run.control();
  const mark = await inboxMark(run, person.email);
  const signedIn = authResponse(page, target.origin, '/auth/login');
  await step(page, 'signIn: fill and submit the sign-in form', async () => {
    if (options.steps) await options.steps(page, { email: person.email, password: person.password });
    else { await openStarterForm(page, 'sign-in'); await fillStarterForm(page, person); }
  });
  let result = await step(page, 'signIn: wait for the sign-in response', () => outcome(signedIn, 'sign-in'));
  if (!result.ok) {
    const said = await pageSays(page);
    throw new StepError(`signIn: the app refused the sign-in (HTTP ${result.status} ${result.code})${said ? `; the page says "${said}"` : ''}`);
  }
  if (result.mfa) {
    const [code] = await step(page, 'signIn: read the emailed sign-in code', () => freshCodes(run, person.email, mark, 'signIn'));
    const challenged = authResponse(page, target.origin, '/auth/mfa/challenge');
    await step(page, 'signIn: enter the emailed sign-in code', () => (options.codeSteps ?? enterStarterCode)(page, code));
    result = await step(page, 'signIn: wait for the code step response', () => outcome(challenged, 'sign-in code'));
    if (!result.ok) throw new StepError(`signIn: the app refused the emailed code (HTTP ${result.status} ${result.code})`);
  }
  if (result.id && result.id !== person.id) throw new StepError('signIn: the app signed in a different account than this person');
  if (!options.steps) await step(page, 'signIn: wait for the signed-in page', () => ready(page, 'signed-in'));
  await run.attach(page);
}

async function signOut(run: FormRun, page: Page, options: { steps?: (page: Page) => Promise<void> }): Promise<void> {
  run.pages.add(page);
  await step(page, 'signOut', async () => {
    if (options.steps) { await options.steps(page); return; }
    await hook(page, 'sign-out').click();
    await ready(page, 'signed-out');
  });
}
