import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { APIRequestContext, BrowserContext, LaunchOptions, Locator, Page } from '@playwright/test';
import { ApiClient } from './client.js';
import { getToken, loadProjectConfig } from './config.js';
import { loadTestTarget, liveReleaseId, type TestTarget } from './test-target.js';
import { collectFiles } from './files.js';
import { hashFiles } from './base-files.js';
import { deleteAccount, describeSweep, forgetRecord, sweepAccounts } from './form-accounts.js';
import { ready, signIn, signOut, signUp, verify, type Attempt, type FormAdapter, type FormControl, type FormHost, type Person, type SignInOptions, type SignUpOptions } from './form-auth.js';
import { rememberSecrets } from './test-diagnostics.js';
import { span } from './test-timeline.js';

// Helpers for an ordinary Node or Playwright script that tests a linked Somewhere app: no runner,
// no fixtures, no config. The script owns its browser; this owns only the accounts it signs up
// (deleted by exact id in finish()) and the result file it writes once.

/** Chrome resolves the app's host through the operating system instead of its own DNS client,
 *  which on some networks waits seconds per fresh browser. Use: chromium.launch(launchOptions()). */
export function launchOptions(extra: LaunchOptions = {}): LaunchOptions {
  return { ...extra, args: ['--disable-features=AsyncDns', ...(extra.args ?? [])] };
}

export interface DataRequest { table: string; operation: 'list' | 'get' | 'create' | 'update' | 'delete' | (string & {}); id?: string | number; values?: Record<string, unknown>; where?: Record<string, unknown>; limit?: number; after?: string | number }
/** What an answer means:
 *  - ok: the operation ran and returned data;
 *  - empty: a list with no rows or a get with null (a missing row and a hidden row look the same);
 *  - refused: 401/403;
 *  - missing-or-refused: 404 DATA_NOT_FOUND on update/delete (a missing row and a refused write look the same);
 *  - malformed: 400 (the request is wrong; it proves nothing about access);
 *  - stale-contract: 409 (the app changed since this script read its contract; it proves nothing);
 *  - error: anything else. */
export type DataKind = 'ok' | 'empty' | 'refused' | 'missing-or-refused' | 'malformed' | 'stale-contract' | 'error';
export interface DataResult { status: number; kind: DataKind; data: unknown; error: string | null; message: string | null }
type Who = Page | BrowserContext | APIRequestContext;

export interface Check { name: string; ok: boolean; ms: number; error?: string }
export interface OpenOptions {
  /** The linked project folder (default: the current directory). */
  projectDir?: string;
  /** Where the result is written once, at finish() (default .somewhere/app-check.json). */
  results?: string;
  /** 'refuse' (default): stop when this folder has published files the live release does not have
   *  (an undeployed or refused change), so the script never tests an old release. */
  undeployed?: 'refuse' | 'allow';
}

function clientOf(who: Who): APIRequestContext {
  if (typeof (who as Page).goto === 'function') return (who as Page).context().request;
  if (typeof (who as BrowserContext).newPage === 'function') return (who as BrowserContext).request;
  return who as APIRequestContext;
}

/** Published files of this folder that differ from what it last deployed, or null when unknown. */
export function undeployedChanges(root: string, projectId: string): { release: string | null; changed: string[] } | null {
  const path = join(root, '.somewhere', 'base-files.json');
  if (!existsSync(path)) return null;
  const base = JSON.parse(readFileSync(path, 'utf8')) as { project_id?: string; release_id?: string | null; files?: Record<string, string> };
  if (base.project_id !== projectId || !base.files) return null;
  const now = hashFiles(root, collectFiles(root).published);
  const changed = [...new Set([...Object.keys(base.files), ...Object.keys(now)])].filter(file => base.files![file] !== now[file]).sort();
  return { release: base.release_id ?? null, changed };
}

/** What a data-endpoint answer means (see DataKind). */
export function classifyData(status: number, raw: unknown): DataResult {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const error = typeof body?.error === 'string' ? body.error : null;
  const message = typeof body?.message === 'string' ? body.message : null;
  const data = body?.data ?? null;
  const kind: DataKind = status === 200
    ? ((Array.isArray(data) && data.length === 0) || data === null ? 'empty' : 'ok')
    : status === 401 || status === 403 ? 'refused'
      : status === 404 && error === 'DATA_NOT_FOUND' ? 'missing-or-refused'
        : status === 400 ? 'malformed'
          : status === 409 ? 'stale-contract' : 'error';
  return { status, kind, data, error, message };
}

export class AppTest {
  readonly origin: string;
  readonly release: string;
  readonly checks: Check[] = [];
  private readonly host: FormHost;
  private readonly started = new Date();
  private finished = false;

  private constructor(readonly root: string, private readonly client: ApiClient, readonly projectId: string, private readonly target: TestTarget, private readonly resultsPath: string) {
    this.origin = target.origin;
    this.release = target.releaseId;
    const control: FormControl = { client, projectId, target };
    this.host = {
      pages: new Set<Page>(), attempts: [] as Attempt[], root,
      control: async () => control, attach: async () => {}, allowTime: () => {},
      timed: (name, work) => span(name, {}, work),
    };
  }

  static async open(options: OpenOptions = {}): Promise<AppTest> {
    const root = resolve(options.projectDir ?? process.cwd());
    const projectId = loadProjectConfig(root)?.project_id;
    if (!projectId) throw new Error(`${root} is not a linked Somewhere project (no .somewhere.json with a project_id).`);
    const client = new ApiClient(getToken());
    const target = await loadTestTarget(client, projectId);
    if ((options.undeployed ?? 'refuse') === 'refuse') {
      const local = undeployedChanges(root, projectId);
      if (local?.changed.length) {
        throw new Error(`This folder has changes the live release does not have (${local.changed.slice(0, 8).join(', ')}${local.changed.length > 8 ? ', …' : ''}). `
          + 'The last deploy did not publish them (it failed, was refused, or has not run), so testing now would test an old release. Deploy, check that it succeeded, then run this script.');
      }
      if (local && local.release && local.release !== target.releaseId) process.stderr.write(`Note: the live release ${target.releaseId} is not the one this folder last deployed (${local.release}).\n`);
    }
    // Resolve the app's host once through the system resolver, so the browser finds it cached.
    await lookup(new URL(target.origin).hostname).catch(() => {});
    process.env.SW_TEST_RUN ??= randomUUID();
    for (const line of describeSweep(await sweepAccounts(client, root, projectId), 'Before this script')) process.stderr.write(line + '\n');
    return new AppTest(root, client, projectId, target, resolve(root, options.results ?? join('.somewhere', 'app-check.json')));
  }

  /** Browser launch options for this app: chromium.launch(app.launchOptions()). */
  launchOptions(extra?: LaunchOptions): LaunchOptions { return launchOptions(extra); }

  /** Sign up through the app's own form on this page (a fresh reserved address). The page opens
   *  the form itself; `form` adapts to a form without the starter's data-sw-auth hooks. */
  signUp(page: Page, options: SignUpOptions = {}): Promise<Person> { return signUp(this.host, page, options); }
  signIn(page: Page, person: Person, options: SignInOptions = {}): Promise<void> { return signIn(this.host, page, person, options); }
  signOut(page: Page, options: { form?: FormAdapter; steps?: (page: Page) => Promise<void> } = {}): Promise<void> { return signOut(this.host, page, options); }
  /** Verify the person's address with the code the app emailed to it (read from the test inbox). */
  verify(page: Page, person: Person): Promise<void> { return verify(this.host, page, person); }

  /** One request to the app's data endpoint as whoever `who` is signed in as (a page, its browser
   *  context, or a request context): { table, operation, id?, values?, where?, limit? }. The app
   *  Origin and the release's data contract are added for you. */
  async data(who: Who, request: DataRequest): Promise<DataResult> {
    const response = await clientOf(who).post(this.origin + '/__sw/data', {
      data: { ...request, contract: this.target.contractDigest ?? '' },
      headers: { Origin: this.origin }, failOnStatusCode: false, maxRedirects: 0,
    });
    let body: unknown = null;
    try { body = await response.json(); } catch { /* not JSON */ }
    return classifyData(response.status(), body);
  }

  /** Throws unless `who` was refused. An empty read or a 404 on a write counts only with
   *  { allowed }: someone the same read returns data for, or for whom the row exists before and
   *  is unchanged after. A malformed request or stale contract never counts. */
  async expectRefused(who: Who, request: DataRequest, options: { allowed?: Who } = {}): Promise<DataResult> {
    const label = `${request.operation} on ${request.table}`;
    const writing = request.operation === 'update' || request.operation === 'delete';
    const rowOf = async (as: Who) => (await this.data(as, { table: request.table, operation: 'get', id: request.id })).data;
    const before = writing && options.allowed && request.id !== undefined ? JSON.stringify(await rowOf(options.allowed)) : undefined;
    if (before === 'null') throw new Error(`expectRefused: ${request.table} ${String(request.id)} does not exist for the allowed person, so there is nothing to refuse. Create the row first.`);
    const result = await this.data(who, request);
    const said = `${label} answered HTTP ${result.status}${result.error ? ' ' + result.error : ''}${result.message ? ` (${result.message})` : ''}`;
    if (result.kind === 'malformed' || result.kind === 'stale-contract') throw new Error(`expectRefused: ${said}: the request was malformed or the app's contract changed, so nothing ran and this proves nothing about access.`);
    if (result.kind === 'ok') throw new Error(`expectRefused: ${said}: it was allowed, not refused.`);
    if (result.kind === 'error') throw new Error(`expectRefused: ${said}: not a refusal.`);
    if (result.kind === 'refused') return result;
    if (!options.allowed) throw new Error(`expectRefused: ${said}: an empty answer or a 404 looks the same as a missing row, so it proves nothing on its own. Pass { allowed: <someone the same request succeeds for> }.`);
    if (writing) {
      if (JSON.stringify(await rowOf(options.allowed)) !== before) throw new Error(`expectRefused: ${said}, but the row changed for the allowed person afterwards.`);
    } else {
      const control = await this.data(options.allowed, request);
      if (control.kind !== 'ok') throw new Error(`expectRefused: ${said}, but the allowed person got ${control.kind} too, so there was nothing to refuse.`);
    }
    return result;
  }

  /** Run one named check; a failure is recorded with its message and the script continues. */
  async check(name: string, work: () => unknown | Promise<unknown>): Promise<boolean> {
    const start = performance.now();
    try { await work(); this.checks.push({ name, ok: true, ms: Math.round(performance.now() - start) }); return true; }
    catch (error) {
      this.checks.push({ name, ok: false, ms: Math.round(performance.now() - start), error: error instanceof Error ? error.message.split('\n').slice(0, 6).join('\n') : String(error) });
      return false;
    }
  }

  /** Confirm the release did not change, delete this script's sign-up accounts by exact id, write
   *  the result once, print one summary, and set a non-zero exit code if anything failed. */
  async finish(): Promise<{ passed: number; failed: number; file: string }> {
    if (this.finished) throw new Error('finish() already ran');
    this.finished = true;
    const live = await liveReleaseId(this.client, this.projectId).catch(() => null);
    if (live !== this.release) this.checks.push({ name: 'the release stayed the same during the script', ok: false, ms: 0, error: live ? `the live release changed from ${this.release} to ${live} during the script; these results describe no single release` : 'the live release could not be confirmed at the end' });
    const cleanup: string[] = [];
    await Promise.all(this.host.attempts.map(async attempt => {
      if (attempt.id) {
        const refused = await deleteAccount(this.client, this.projectId, attempt.id);
        if (refused === null) forgetRecord(attempt.record);
        else cleanup.push(`could not delete ${attempt.email} (${refused}); its record is kept and the next run retries`);
      } else if (attempt.submitted && !attempt.refused) {
        cleanup.push(`a sign-up for ${attempt.email} was submitted but returned no account id, so nothing was deleted`);
        forgetRecord(attempt.record);
      } else forgetRecord(attempt.record);
    }));
    for (const page of this.host.pages) try { rememberSecrets(...(await page.context().cookies()).map(cookie => cookie.value)); } catch { /* closed */ }
    if (cleanup.length) this.checks.push({ name: 'cleanup of sign-up accounts', ok: false, ms: 0, error: cleanup.join('; ') });
    const passed = this.checks.filter(check => check.ok).length;
    const failed = this.checks.length - passed;
    mkdirSync(dirname(this.resultsPath), { recursive: true });
    writeFileSync(this.resultsPath, JSON.stringify({ origin: this.origin, release: this.release, started: this.started.toISOString(), finished: new Date().toISOString(), passed, failed, checks: this.checks }, null, 2) + '\n');
    for (const check of this.checks.filter(c => !c.ok)) process.stdout.write(`FAIL ${check.name}\n  ${(check.error ?? '').replaceAll('\n', '\n  ')}\n`);
    process.stdout.write(`${failed || !passed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed · ${this.origin} · ${this.release} · ${this.resultsPath}\n`);
    if (failed || !passed) process.exitCode = 1;
    return { passed, failed, file: this.resultsPath };
  }
}

/** Open a linked project for a plain script: reads its live origin, release and data contract. */
export function openAppTest(options?: OpenOptions): Promise<AppTest> { return AppTest.open(options); }

export interface Captured { url: string; status: number; contentType: string; body: string }
/** Record every response this page receives (documents, scripts, data) with its body, so a
 *  privacy check can wait for all of them and say exactly where a secret appeared. */
export function captureResponses(page: Page) {
  const pending: Promise<Captured | null>[] = [];
  const listener = (response: import('@playwright/test').Response) => {
    const url = new URL(response.url());
    pending.push(response.text().then(body => ({ url: url.origin + url.pathname, status: response.status(), contentType: response.headers()['content-type'] ?? '', body })).catch(() => null));
  };
  page.on('response', listener);
  return {
    /** Every captured response, after each body has been read. */
    async all(): Promise<Captured[]> { return (await Promise.all(pending)).filter((c): c is Captured => c !== null); },
    /** Where `secret` appeared: URL, status, content type and the text around it. Use a unique value you planted. */
    async find(secret: string): Promise<{ url: string; status: number; contentType: string; around: string }[]> {
      return (await this.all()).filter(c => c.body.includes(secret)).map(c => {
        const at = c.body.indexOf(secret);
        return { url: c.url, status: c.status, contentType: c.contentType, around: c.body.slice(Math.max(0, at - 60), at + secret.length + 60) };
      });
    },
    stop(): void { page.off('response', listener); },
  };
}

/** Wait until the page's data views have finished loading: the starter marks each with
 *  data-sw-data="loading" | "ready" | "error". Signed-in is not "the list has loaded". */
export async function dataReady(scope: Page | Locator, timeout = 15_000): Promise<'ready' | 'error'> {
  const root = typeof (scope as Page).goto === 'function' ? (scope as Page).locator(':root') : scope as Locator;
  const views = root.locator('[data-sw-data]');
  await views.first().waitFor({ state: 'attached', timeout });
  await root.locator('[data-sw-data="loading"]').first().waitFor({ state: 'detached', timeout }).catch(async () => {
    if (await root.locator('[data-sw-data="loading"]').count()) throw new Error(`dataReady: a data view was still loading after ${timeout / 1000} s`);
  });
  return (await root.locator('[data-sw-data="error"]').count()) ? 'error' : 'ready';
}

export { ready };
