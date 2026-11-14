import type { APIResponse, Locator, Page } from '@playwright/test';
import type { ApiClient } from './client.js';
import type { TestTarget } from './test-target.js';
import { messagesAfter, type InboxMessage } from './test-identities.js';
import { rememberSecrets, scrub } from './test-diagnostics.js';
import { mark as timelineMark, span } from './test-timeline.js';
import { admitReservedAddress, generatedAddress, generatedPassword, recordAttempt, recordId } from './form-accounts.js';

// Sign-up, sign-in, sign-out and email verification through the app's own form, usable from the
// somewhere test fixtures and from any plain Node or Playwright script (src/script.ts). The form is
// found by what each control does, not by one layout: an email field, a password field, a sign-up
// action and a sign-in action, whether both buttons are visible or a mode switch reveals one.
// The starter marks them with data-sw-auth; any other form passes a small adapter of selectors.
// When nothing fits, it fails within FIND_MS and says what to add.

/** An ordinary account made through the app's own sign-up form. `verified` is true once its
 *  address was verified with a captured code (verify(), or a project that requires email codes). */
export interface Person { id: string; email: string; password: string; verified: boolean }
/** Your own form steps, for an app whose form no adapter fits. They run after the app is open. */
export type FormSteps = (page: Page, input: { email: string; password: string }) => Promise<void>;
/** Your own steps to enter an emailed sign-in code. */
export type CodeSteps = (page: Page, code: string) => Promise<void>;
/** Where one of the form's controls is: a CSS selector, or a function returning a Locator. */
export type Control = string | ((page: Page) => Locator);
/** The form's controls, each defaulting to the starter's data-sw-auth hook. `mode` switches
 *  between signing up and signing in, for forms that show one action at a time. */
export interface FormAdapter {
  /** The page that shows the form when signed out (default '/'). */
  path?: string;
  email?: Control; password?: Control; signUp?: Control; signIn?: Control; mode?: Control; signOut?: Control;
  /** Something visible only when signed in, for apps without the starter's data-app-state. */
  signedIn?: Control;
}
export interface SignUpOptions { domain?: string; email?: string; form?: FormAdapter; steps?: FormSteps; codeSteps?: CodeSteps }
export interface SignInOptions { form?: FormAdapter; steps?: FormSteps; codeSteps?: CodeSteps }
export interface Attempt { email: string; record: string; id: string | null; submitted: boolean; refused: boolean }
export interface FormControl { client: ApiClient; projectId: string; target: TestTarget }
/** What a caller provides: the somewhere test fixture, or a plain script's session. */
export interface FormHost {
  readonly pages: Set<Page>;
  readonly attempts: Attempt[];
  /** The project folder: where sign-ups are recorded for exact-id cleanup. */
  readonly root: string;
  control(): Promise<FormControl>;
  /** Called once a page is signed in (the fixture attaches its data client here). */
  attach(page: Page): Promise<void>;
  /** Room for real mail paths inside a test timeout, if there is one. */
  allowTime(ms: number): void;
  timed<T>(name: string, work: () => Promise<T>): Promise<T>;
}

export const FIND_MS = 5_000;
export const DEFAULT_FORM: Required<Omit<FormAdapter, 'path' | 'signedIn'>> = {
  email: '[data-sw-auth="email"]', password: '[data-sw-auth="password"]',
  signUp: '[data-sw-auth="sign-up"]', signIn: '[data-sw-auth="sign-in"]',
  mode: '[data-sw-auth="mode"]', signOut: '[data-sw-auth="sign-out"]',
};
const pick = (page: Page, control: Control): Locator => typeof control === 'string' ? page.locator(control) : control(page);
const describe = (control: Control): string => typeof control === 'string' ? control : 'your locator';

/** Wait for the starter's session check to settle (data-app-state on the app root, outside any
 *  form). 'ready' is either state; a Locator waits for that element instead. */
export async function ready(page: Page, state: 'ready' | 'signed-in' | 'signed-out' | Locator = 'ready'): Promise<void> {
  const locator = typeof state === 'string' ? page.locator(state === 'ready' ? '[data-app-state="signed-in"], [data-app-state="signed-out"]' : `[data-app-state="${state}"]`) : state;
  await span('ready', { state: typeof state === 'string' ? state : 'locator' }, () => locator.waitFor({ state: 'visible' }));
}
/** The auth state, when the app publishes it; an app without data-app-state is not waited on. */
async function authState(page: Page, state: 'signed-in' | 'signed-out'): Promise<void> {
  if (!(await page.locator('[data-app-state]').count())) return;
  await page.locator(`[data-app-state="${state}"]`).waitFor({ state: 'visible', timeout: 15_000 });
}
async function signedIn(page: Page, form?: FormAdapter): Promise<void> {
  if (form?.signedIn) await pick(page, form.signedIn).first().waitFor({ state: 'visible', timeout: 15_000 });
  else await authState(page, 'signed-in');
}
/** Open the page that shows the form and wait until the app says who is signed in. */
async function openSignedOut(page: Page, form?: FormAdapter): Promise<void> {
  await page.goto(form?.path ?? '/');
  const root = page.locator('[data-app-state]');
  // Whichever comes first: the app's session state (the starter publishes it) or the form itself.
  await root.or(pick(page, form?.email ?? DEFAULT_FORM.email)).first().waitFor({ state: 'attached', timeout: FIND_MS }).catch(() => {});
  if (await root.count()) {
    await page.locator('[data-app-state="signed-in"], [data-app-state="signed-out"]').waitFor({ state: 'visible', timeout: 15_000 });
    if (await page.locator('[data-app-state="signed-in"]').count()) throw new Error('this page is already signed in; call signOut(page) first or use another page');
  }
}
/** Fill and submit the form for one action, found by what each control does. */
async function submitForm(page: Page, action: 'sign-up' | 'sign-in', input: { email: string; password: string }, form: FormAdapter = {}): Promise<void> {
  const f = { ...DEFAULT_FORM, ...form };
  const wanted = pick(page, action === 'sign-up' ? f.signUp : f.signIn).first();
  const missing = (what: string, control: Control) => new StepError(`${action === 'sign-up' ? 'signUp' : 'signIn'}: no ${what} (${describe(control)}) on ${form.path ?? '/'} within ${FIND_MS / 1000} s. `
    + 'Mark your form\'s controls with data-sw-auth="email", "password", "sign-up" and "sign-in" (and "mode" if one control switches between them), '
    + 'or pass { form: { email, password, signUp, signIn } } with your own selectors.');
  await pick(page, f.email).first().waitFor({ state: 'visible', timeout: FIND_MS }).catch(() => { throw missing('email field', f.email); });
  if (!(await wanted.isVisible())) {
    // Starters before 0.38.88: one submit button, and the form's current mode on data-sw-auth-mode.
    const legacy = page.locator('[data-sw-auth="form"][data-sw-auth-mode]');
    if (!form.signUp && !form.signIn && await legacy.count() && await page.locator('[data-sw-auth="submit"]').count()) {
      if ((await legacy.first().getAttribute('data-sw-auth-mode')) !== action) {
        await pick(page, f.mode).first().click();
        await page.locator(`[data-sw-auth="form"][data-sw-auth-mode="${action}"]`).waitFor({ timeout: FIND_MS });
      }
      await pick(page, f.email).first().fill(input.email);
      await pick(page, f.password).first().fill(input.password);
      await page.locator('[data-sw-auth="submit"]').first().click();
      return;
    }
    // One action at a time: the mode control reveals the other.
    const mode = pick(page, f.mode).first();
    if (await mode.isVisible()) await mode.click();
    await wanted.waitFor({ state: 'visible', timeout: FIND_MS }).catch(() => { throw missing(`${action} action`, action === 'sign-up' ? f.signUp : f.signIn); });
  }
  await pick(page, f.email).first().fill(input.email);
  const password = pick(page, f.password).first();
  await password.waitFor({ state: 'visible', timeout: FIND_MS }).catch(() => { throw missing('password field', f.password); });
  await password.fill(input.password);
  await wanted.click();
}

// ---------------------------------------------------------------- sign-up through the app's form
//
// signUp/verify/signIn/signOut drive the app's own pages. The developer credential stays in this
// process and is used only on the control plane: to read the captured code for the exact address
// (GET /email/test-inbox) and to delete the exact account ids this test created. The browser and
// the app only ever see the person's own email, password and code, typed into the app's form.

const marks = new WeakMap<Person, InboxMark>();
/** When the last emailed sign-in code for a person was read (the platform sends at most one a minute). */
const lastSignInCode = new WeakMap<Person, number>();
const CODE_GAP_MS = 61_000;
interface InboxMark { seen: Set<string>; since: number }

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
  try { return await span(name, {}, work); }
  catch (error) {
    if (error instanceof StepError) throw error;
    const said = await pageSays(page);
    const cause = scrub(error instanceof Error ? error.message : String(error)).slice(0, 600);
    throw new StepError(`${name} failed${said ? `; the page says "${said}"` : ''}: ${cause}`);
  }
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

async function inbox(run: FormHost, address: string, wait?: { since: number; ms?: number }): Promise<InboxMessage[]> {
  const { client, projectId } = await run.control();
  const body = await run.timed('test inbox', () => client.call<{ messages?: unknown }>('GET', '/email/test-inbox', undefined,
    { project_id: projectId, address, limit: 20, ...(wait ? { wait_ms: wait.ms ?? 10_000, since: wait.since } : {}) }));
  return messagesAfter(body.messages, address, 0);
}
/** What the test inbox already holds for this address, so a code is only ever one sent after this point. */
async function inboxMark(run: FormHost, address: string): Promise<InboxMark> {
  const messages = await inbox(run, address);
  return { seen: new Set(messages.map(message => message.id)), since: Math.max(0, ...messages.map(message => Date.parse(message.created_at))) };
}
/** Codes in messages to exactly this address that arrived after the mark, newest first, consumed
 *  from the mark. One long-poll of at most `ms`. */
async function takeCodes(run: FormHost, address: string, mark: InboxMark, ms: number): Promise<string[]> {
  const fresh = (await inbox(run, address, { since: mark.since, ms })).filter(message => !mark.seen.has(message.id));
  for (const message of fresh) { mark.seen.add(message.id); mark.since = Math.max(mark.since, Date.parse(message.created_at)); }
  const codes = fresh.flatMap(message => message.verification_code ? [message.verification_code] : []);
  rememberSecrets(...codes);
  return codes;
}
/** Like takeCodes, waiting up to 25 s for at least one. */
async function freshCodes(run: FormHost, address: string, mark: InboxMark, what: string): Promise<string[]> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const codes = await takeCodes(run, address, mark, 10_000);
    if (codes.length) return codes;
    if (Date.now() > deadline) throw new Error(`${what}: no code reached the project's test inbox for ${address} within 25 s. The test inbox holds at most a limited number of messages for 7 days; when it is full, new mail is not stored.`);
  }
}

export async function signUp(run: FormHost, page: Page, options: SignUpOptions): Promise<Person> {
  if (options.domain !== undefined && options.email !== undefined) throw new Error('signUp: pass domain or email, not both.');
  const email = options.email !== undefined ? admitReservedAddress(options.email) : generatedAddress(options.domain);
  const password = generatedPassword();
  rememberSecrets(password);
  run.allowTime(20_000);
  run.pages.add(page);
  const { target, projectId } = await run.control();
  const mark = await inboxMark(run, email);
  const attempt: Attempt = { email, record: recordAttempt(run.root, projectId, email), id: null, submitted: false, refused: false };
  run.attempts.push(attempt);
  const onRequest = (request: { method(): string; url(): string }) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/auth/signup')) attempt.submitted = true;
  };
  page.on('request', onRequest);
  const signedUp = authResponse(page, target.origin, '/auth/signup');
  try {
    await step(page, 'signUp: fill and submit the sign-up form', async () => {
      await openSignedOut(page, options.form);
      if (options.steps) await options.steps(page, { email, password });
      else await submitForm(page, 'sign-up', { email, password }, options.form);
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
    await step(page, 'signUp: wait for the signed-in page', () => signedIn(page, options.form));
    await run.attach(page);
    const person: Person = { id, email, password, verified };
    marks.set(person, mark);
    if (result.mfa) lastSignInCode.set(person, Date.now());
    return person;
  } finally { page.off('request', onRequest); }
}

export async function verify(run: FormHost, page: Page, person: Person): Promise<void> {
  run.allowTime(20_000);
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
      timelineMark('wait', { ms: 250, why: 'verify: code not installed yet (404)' });
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

export async function signIn(run: FormHost, page: Page, person: Person, options: SignInOptions): Promise<void> {
  rememberSecrets(person.password);
  run.allowTime(20_000);
  run.pages.add(page);
  const { target } = await run.control();
  const mark = await inboxMark(run, person.email);
  const submit = async () => {
    const signedIn = authResponse(page, target.origin, '/auth/login');
    await step(page, 'signIn: fill and submit the sign-in form', async () => {
      await openSignedOut(page, options.form);
      if (options.steps) await options.steps(page, { email: person.email, password: person.password });
      else await submitForm(page, 'sign-in', person, options.form);
    });
    return step(page, 'signIn: wait for the sign-in response', () => outcome(signedIn, 'sign-in'));
  };
  let result = await submit();
  // A project that requires email codes sends at most one code per account per minute. Signing back
  // in within a minute of the last code is refused (429) before a code is sent, so wait out the rest
  // of that minute, as the person would, and submit once more.
  if (result.status === 429 && (result.code === 'AUTH_MFA_SEND_LIMITED' || /code was sent recently/i.test(await pageSays(page)))) {
    const wait = Math.max(0, CODE_GAP_MS - (Date.now() - (lastSignInCode.get(person) ?? 0)));
    const waitMs = Math.min(wait, CODE_GAP_MS);
    run.allowTime(waitMs + 10_000);
    timelineMark('wait', { ms: waitMs, why: 'signIn: one emailed code a minute' });
    await page.waitForTimeout(waitMs);
    result = await submit();
  }
  if (!result.ok) {
    const said = await pageSays(page);
    throw new StepError(`signIn: the app refused the sign-in (HTTP ${result.status} ${result.code})${said ? `; the page says "${said}"` : ''}`);
  }
  if (result.mfa) {
    const [code] = await step(page, 'signIn: read the emailed sign-in code', () => freshCodes(run, person.email, mark, 'signIn'));
    lastSignInCode.set(person, Date.now());
    const challenged = authResponse(page, target.origin, '/auth/mfa/challenge');
    await step(page, 'signIn: enter the emailed sign-in code', () => (options.codeSteps ?? enterStarterCode)(page, code));
    result = await step(page, 'signIn: wait for the code step response', () => outcome(challenged, 'sign-in code'));
    if (!result.ok) throw new StepError(`signIn: the app refused the emailed code (HTTP ${result.status} ${result.code})`);
  }
  if (result.id && result.id !== person.id) throw new StepError('signIn: the app signed in a different account than this person');
  await step(page, 'signIn: wait for the signed-in page', () => signedIn(page, options.form));
  await run.attach(page);
}

export async function signOut(run: FormHost, page: Page, options: { steps?: (page: Page) => Promise<void>; form?: FormAdapter }): Promise<void> {
  run.pages.add(page);
  await step(page, 'signOut', async () => {
    if (options.steps) await options.steps(page);
    else {
      const control = options.form?.signOut ?? DEFAULT_FORM.signOut;
      const action = pick(page, control).first();
      await action.waitFor({ state: 'visible', timeout: FIND_MS }).catch(() => {
        throw new StepError(`signOut: no sign-out control (${describe(control)}) on this page within ${FIND_MS / 1000} s. Add data-sw-auth="sign-out" to it, or pass { form: { signOut: '<selector>' } }.`);
      });
      await action.click();
    }
    await authState(page, 'signed-out');
  });
}
