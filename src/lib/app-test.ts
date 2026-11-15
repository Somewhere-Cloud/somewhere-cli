import { randomUUID } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { testAddressOrder } from './test-connectivity.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { APIRequestContext, BrowserContext, LaunchOptions, Locator, Page } from '@playwright/test';
import { loadProjectConfig } from './config.js';
import type { TestTarget } from './test-target.js';
import { collectFiles } from './files.js';
import { hashFiles } from './base-files.js';
import { describeSweep, forgetRecord, sweepAccounts } from './form-accounts.js';
import { openPreviewControl, openProductionControl, type TestControl } from './test-control.js';
import { loadPreviewRecord } from './preview-record.js';
import { ready, signIn, signOut, signUp, verify, type Attempt, type FormAdapter, type FormControl, type FormHost, type Person, type SignInOptions, type SignUpOptions } from './form-auth.js';
import { rememberSecrets, scrub } from './test-diagnostics.js';
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
 *  - malformed: 400/405/413/415, or 403 DATA_ORIGIN_FORBIDDEN (the request is wrong; it proves nothing about access);
 *  - stale-contract: 409 DATA_CONTRACT_MISMATCH (the app changed since the contract was read; it proves nothing);
 *  - error: anything else, such as 409 DATA_CONFLICT (a unique-key conflict). */
export type DataKind = 'ok' | 'empty' | 'refused' | 'missing-or-refused' | 'malformed' | 'stale-contract' | 'error';
export interface DataResult { status: number; kind: DataKind; data: unknown; error: string | null; message: string | null }
type Who = Page | BrowserContext | APIRequestContext;

/** One check's outcome. `skipped` says why it did not run: an earlier check failed, or (with --failed) it passed last run. */
/** One check's outcome. `skipped` says why it did not run; a pass carried by --failed names the run and release it came from. */
export interface Check { name: string; ok: boolean; ms: number; error?: string; skipped?: 'after-failure' | 'passed-last-run'; carried_from?: { run: string; release: string } }
/** What a result file was run against; --failed carries passes only between runs with the same identity. */
export interface RunIdentity { project_id: string; environment: string; preview_session_id: string | null; origin: string; script: string | null }
/** Passes the previous result may carry into this run, or the reason it may not. */
export function carriedPasses(last: { checks?: Check[]; identity?: Partial<RunIdentity>; release?: string; started?: string } | null, identity: RunIdentity):
  { ok: true; passes: Map<string, { run: string; release: string }> } | { ok: false; reason: string } {
  if (!last) return { ok: false, reason: 'there is no previous result; run the whole script once first' };
  if (!last.identity) return { ok: false, reason: 'the previous result does not record what it ran against (an older CLI wrote it); run the whole script once' };
  for (const key of ['project_id', 'environment', 'preview_session_id', 'origin', 'script'] as const) {
    if ((last.identity[key] ?? null) !== identity[key]) {
      return { ok: false, reason: `the previous result ran against a different ${key.replace('_', ' ')} (${String(last.identity[key] ?? 'none')}, now ${String(identity[key] ?? 'none')}); run the whole script once` };
    }
  }
  const passes = new Map<string, { run: string; release: string }>();
  for (const check of last.checks ?? []) {
    if (check.ok) passes.set(check.name, check.carried_from ?? { run: last.started ?? 'unknown', release: last.release ?? 'unknown' });
  }
  return { ok: true, passes };
}
export interface OpenOptions {
  /** The linked project folder (default: the current directory). */
  projectDir?: string;
  /** Where the result is written once, at finish() (default .somewhere/app-check.json). */
  results?: string;
  /** 'refuse' (default): stop when this folder has published files the live release does not have
   *  (an undeployed or refused change), so the script never tests an old release. With `preview`, the
   *  same check is against what this folder last saved to its preview. */
  undeployed?: 'refuse' | 'allow';
  /** Test this folder's open preview instead of production (true), or a named preview session. The
   *  script uses only the preview's own credential, is pinned to the version saved when it opens,
   *  and never touches production. Prepare each browser context with app.prepare(context), or let
   *  signUp/signIn/verify/data do it for the page they get. */
  preview?: boolean | string;
  /** Run only the checks that did not pass in the previous result file (default: true when the
   *  script was started with --failed). Use it after a fix instead of rerunning everything. */
  onlyFailed?: boolean;
}

/** Where a page is and what it says: its URL and any visible alert or error text (scrubbed). */
async function pageState(page: Page): Promise<string> {
  if (page.isClosed()) return 'closed';
  try {
    // A string, so this module needs no DOM types: visible alert or error text, else the page's first words.
    const shown = await page.evaluate(`(() => {
      const said = [...document.querySelectorAll('[role="alert"], [data-sw-auth="error"], [data-sw-data="error"], [aria-invalid="true"], .error')]
        .filter((el) => el.getClientRects().length > 0).map((el) => el.innerText.trim()).filter(Boolean);
      return said.length ? 'shows: ' + said.slice(0, 3).join(' | ')
        : 'no error text; page starts: ' + (document.body ? document.body.innerText : '').trim().replace(/\\s+/g, ' ').slice(0, 160);
    })()`) as string;
    return scrub(`${page.url()} ${shown}`).slice(0, 400);
  } catch { return scrub(page.url()); }
}

function clientOf(who: Who): APIRequestContext {
  if (typeof (who as Page).goto === 'function') return (who as Page).context().request;
  if (typeof (who as BrowserContext).newPage === 'function') return (who as BrowserContext).request;
  return who as APIRequestContext;
}

/** Published files of this folder that differ from what it last deployed (or, for `preview`, last
 *  saved to its open preview), or null when unknown. */
export function undeployedChanges(root: string, projectId: string, preview = false): { release: string | null; changed: string[] } | null {
  let base: { project_id?: string; release_id?: string | null; files?: Record<string, string> };
  if (preview) {
    const record = loadPreviewRecord(root, projectId);
    if (!record) return null;
    base = { project_id: record.project_id, release_id: record.preview_id, files: record.files };
  } else {
    const path = join(root, '.somewhere', 'base-files.json');
    if (!existsSync(path)) return null;
    base = JSON.parse(readFileSync(path, 'utf8')) as typeof base;
  }
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
  // A wrong Origin or a malformed body is the request's fault, never an access answer; a 409 is a
  // stale contract only with DATA_CONTRACT_MISMATCH (DATA_CONFLICT is a real unique-key conflict).
  const kind: DataKind = status === 200
    ? ((Array.isArray(data) && data.length === 0) || data === null ? 'empty' : 'ok')
    : status === 403 && error === 'DATA_ORIGIN_FORBIDDEN' ? 'malformed'
      : status === 401 || status === 403 ? 'refused'
        : status === 404 && error === 'DATA_NOT_FOUND' ? 'missing-or-refused'
          : [400, 405, 413, 415].includes(status) ? 'malformed'
            : status === 409 && error === 'DATA_CONTRACT_MISMATCH' ? 'stale-contract' : 'error';
  return { status, kind, data, error, message };
}

export class AppTest {
  readonly origin: string;
  readonly release: string;
  readonly checks: Check[] = [];
  private readonly host: FormHost;
  private readonly started = new Date();
  private finished = false;
  private stopped = false;
  private passedLastRun = new Map<string, { run: string; release: string }>();

  private readonly prepared = new WeakSet<BrowserContext>();
  private readonly target: TestTarget;
  readonly projectId: string;

  private constructor(readonly root: string, private readonly control: TestControl, private readonly resultsPath: string) {
    this.target = control.target;
    this.projectId = control.projectId;
    this.origin = control.target.origin;
    this.release = control.target.releaseId;
    const form: FormControl = { control };
    this.host = {
      pages: new Set<Page>(), attempts: [] as Attempt[], root,
      control: async () => form, attach: async () => {}, allowTime: () => {},
      prepare: (page) => this.prepare(page),
      timed: (name, work) => span(name, {}, work),
    };
  }

  /** 'production' or 'preview': what this script is testing. */
  get environment(): 'production' | 'preview' { return this.control.environment; }

  /** Make a browser context (or a page's) able to reach the app. Needed only in a preview, where it
   *  adds the script's session pinned to the version saved when the script opened; harmless otherwise. */
  async prepare(who: Page | BrowserContext): Promise<void> {
    const context = typeof (who as Page).goto === 'function' ? (who as Page).context() : who as BrowserContext;
    if (this.prepared.has(context)) return;
    this.prepared.add(context);
    await this.control.prepareContext(context);
  }

  static async open(options: OpenOptions = {}): Promise<AppTest> {
    const root = resolve(options.projectDir ?? process.cwd());
    const projectId = loadProjectConfig(root)?.project_id;
    if (!projectId) throw new Error(`${root} is not a linked Somewhere project (no .somewhere.json with a project_id).`);
    // A preview script uses only the preview's own credential; your sign-in is not read.
    const preview = options.preview !== undefined && options.preview !== false;
    const control = preview
      ? await openPreviewControl({ root, projectId, ...(typeof options.preview === 'string' ? { previewSessionId: options.preview } : {}) })
      : await openProductionControl(projectId);
    const target = control.target;
    if ((options.undeployed ?? 'refuse') === 'refuse') {
      const local = undeployedChanges(root, projectId, preview);
      if (local?.changed.length) {
        throw new Error(preview
          ? `This folder has changes its preview does not have (${local.changed.slice(0, 8).join(', ')}${local.changed.length > 8 ? ', …' : ''}). Save them with \`somewhere preview\`, then run this script.`
          : `This folder has changes the live release does not have (${local.changed.slice(0, 8).join(', ')}${local.changed.length > 8 ? ', …' : ''}). `
            + 'The last deploy did not publish them (it failed, was refused, or has not run), so testing now would test an old release. Deploy, check that it succeeded, then run this script.');
      }
      if (local && local.release && local.release !== target.releaseId) process.stderr.write(`Note: the ${preview ? 'preview\'s saved version' : 'live release'} ${target.releaseId} is not the one this folder last ${preview ? 'saved' : 'deployed'} (${local.release}).\n`);
    }
    // Resolve the app's host once through the system resolver, so the browser finds it cached. Where
    // IPv6 does not connect but IPv4 does, this process prefers IPv4 addresses: Playwright's request
    // client (page.request, app.data) runs here and otherwise waits seconds on every new connection.
    const [ipv4First] = await Promise.all([testAddressOrder(target.origin), lookup(new URL(target.origin).hostname).catch(() => null)]);
    if (ipv4First) setDefaultResultOrder('ipv4first');
    process.env.SW_TEST_RUN ??= randomUUID();
    for (const line of describeSweep(await sweepAccounts(control, root), 'Before this script')) process.stderr.write(line + '\n');
    const app = new AppTest(root, control, resolve(root, options.results ?? join('.somewhere', preview ? 'app-check-preview.json' : 'app-check.json')));
    if (options.onlyFailed ?? process.argv.includes('--failed')) {
      const last = existsSync(app.resultsPath) ? JSON.parse(readFileSync(app.resultsPath, 'utf8')) : null;
      const carried = carriedPasses(last, app.identity());
      if (!carried.ok) throw new Error(`--failed: not carrying earlier passes: ${carried.reason} (${app.resultsPath}).`);
      app.passedLastRun = carried.passes;
    }
    return app;
  }

  /** What this run tests: the project, environment, preview, origin and script. */
  identity(): RunIdentity {
    const script = process.argv[1] ? relative(this.root, resolve(process.argv[1])) : null;
    return { project_id: this.control.projectId, environment: this.control.environment,
      preview_session_id: this.control.environment === 'preview' ? this.target.previewSessionId ?? null : null, origin: this.origin, script };
  }

  /** Register every signed-in page's cookie values as secrets, so no diagnostic can print them. */
  private async rememberPageSecrets(): Promise<void> {
    for (const page of this.host.pages) try { rememberSecrets(...(await page.context().cookies()).map(cookie => cookie.value)); } catch { /* closed */ }
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
    if (typeof (who as Page).goto === 'function' || typeof (who as BrowserContext).newPage === 'function') await this.prepare(who as Page | BrowserContext);
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

  /** Run one named check. The first failure stops the run: it prints the check, the error and
   *  what each signed-in page shows (URL, visible error text), and every later check is skipped
   *  instead of waiting out its own timeout. With --failed, checks that passed last run are skipped. */
  async check(label: string, work: () => unknown | Promise<unknown>): Promise<boolean> {
    // The name is recorded, matched by --failed and printed scrubbed: a check named after a password never stores it.
    const name = scrub(label);
    if (this.stopped) { this.checks.push({ name, ok: false, ms: 0, skipped: 'after-failure' }); return false; }
    const carried = this.passedLastRun.get(name);
    if (carried) { this.checks.push({ name, ok: true, ms: 0, skipped: 'passed-last-run', carried_from: carried }); return true; }
    const start = performance.now();
    try { await work(); this.checks.push({ name, ok: true, ms: Math.round(performance.now() - start) }); return true; }
    catch (error) {
      // Nothing about the failure is printed before every secret it could carry is registered and the whole
      // diagnostic is scrubbed: emailed links, remembered passwords or tokens, session cookies.
      await this.rememberPageSecrets();
      const pages = await Promise.all([...this.host.pages].map(pageState));
      const message = scrub((error instanceof Error ? error.message.split('\n').slice(0, 6).join('\n') : String(error))
        + pages.map((state, i) => `\npage ${i + 1}: ${state}`).join(''));
      this.checks.push({ name, ok: false, ms: Math.round(performance.now() - start), error: message });
      this.stopped = true;
      process.stdout.write(`FAIL ${name}\n  ${message.replaceAll('\n', '\n  ')}\nStopping here: later checks are skipped. After a fix, rerun only what failed: node <this script> --failed\n`);
      return false;
    }
  }

  /** Confirm the release did not change, delete this script's sign-up accounts by exact id, write
   *  the result once, print one summary, and set a non-zero exit code if anything failed. */
  async finish(): Promise<{ passed: number; failed: number; file: string }> {
    if (this.finished) throw new Error('finish() already ran');
    this.finished = true;
    const ranChecks = this.checks.length;
    const preview = this.control.environment === 'preview';
    let ended = '';
    const live = await this.control.currentRelease().catch((error: unknown) => { ended = error instanceof Error ? error.message : ''; return null; });
    if (live !== this.release) this.checks.push({ name: preview ? 'the preview stayed on the same saved version during the script' : 'the release stayed the same during the script', ok: false, ms: 0,
      error: preview
        ? (live ? `the preview was saved again during the script (${this.release} → ${live}); these results describe no single version` : `${ended || 'the preview could not be confirmed at the end'}; nothing ran against production`)
        : live ? `the live release changed from ${this.release} to ${live} during the script; these results describe no single release` : 'the live release could not be confirmed at the end' });
    const cleanup: string[] = [];
    // The script's accounts are deleted together by their exact ids, with the teams only they belong to.
    const withIds = this.host.attempts.filter(attempt => attempt.id);
    const notes: string[] = [];
    if (withIds.length) {
      const deletion = await this.control.deleteSignups([...new Set(withIds.map(attempt => attempt.id!))]);
      for (const attempt of withIds) {
        const id = attempt.id!;
        if (deletion.done.includes(id)) forgetRecord(attempt.record);
        else if (deletion.dropped.has(id)) { forgetRecord(attempt.record); notes.push(`dropped the cleanup record of ${attempt.email}: ${deletion.dropped.get(id)}`); }
        else cleanup.push(`could not delete ${attempt.email} (${deletion.kept.get(id) ?? 'not deleted'}); its record is kept and the next run retries`);
      }
      if (deletion.teamsDeleted.length) notes.push(`deleted ${deletion.teamsDeleted.length} team(s) that only this script's sign-ups belonged to: ${deletion.teamsDeleted.map(team => `"${team.name}" (${team.id})`).join(', ')}`);
    }
    for (const attempt of this.host.attempts.filter(attempt => !attempt.id)) {
      if (attempt.submitted && !attempt.refused) cleanup.push(`a sign-up for ${attempt.email} was submitted but returned no account id, so nothing was deleted`);
      forgetRecord(attempt.record);
    }
    for (const note of notes) process.stderr.write(note + '\n');
    await this.rememberPageSecrets();
    await this.control.close();
    if (cleanup.length) this.checks.push({ name: 'cleanup of sign-up accounts', ok: false, ms: 0, error: cleanup.join('; ') });
    const passed = this.checks.filter(check => check.ok).length;
    const failed = this.checks.filter(check => !check.ok && !check.skipped).length;
    const notRun = this.checks.filter(check => check.skipped === 'after-failure').length;
    const carried = this.checks.filter(check => check.skipped === 'passed-last-run').length;
    mkdirSync(dirname(this.resultsPath), { recursive: true });
    writeFileSync(this.resultsPath, JSON.stringify({ identity: this.identity(), origin: this.origin, environment: this.control.environment, ...(preview ? { preview_session_id: this.target.previewSessionId } : {}), release: this.release,
      started: this.started.toISOString(), finished: new Date().toISOString(), passed, failed, checks: this.checks.map((check) => ({ ...check, ...(check.error ? { error: scrub(check.error) } : {}) })) }, null, 2) + '\n');
    // check() printed its own failure when it happened; print the ones finish() found.
    for (const check of this.checks.slice(ranChecks).filter(c => !c.ok)) process.stdout.write(`FAIL ${scrub(check.name)}\n  ${scrub(check.error ?? '').replaceAll('\n', '\n  ')}\n`);
    if (!this.checks.length) process.stdout.write('FAIL no check ran: the script stopped before its first check (the error is below)\n');
    const sources = [...new Set(this.checks.filter((c) => c.carried_from).map((c) => `${c.carried_from!.release} at ${c.carried_from!.run}`))];
    const extra = `${notRun ? `, ${notRun} not run (stopped at the first failure)` : ''}${carried ? ` (${carried} of the passes were carried from an earlier run, not rerun: ${sources.join('; ')})` : ''}`;
    process.stdout.write(`${failed || !passed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed${extra} · ${preview ? `preview ${this.target.previewSessionId} · ` : ''}${this.origin} · ${this.release} · ${this.resultsPath}\n`);
    // After the version changed there is no same version to rerun on.
    if (live !== this.release) {
      process.stdout.write(preview
        ? 'The preview changed or closed during this script. Save it again with `somewhere preview` (or open a new one if it closed), then run the whole script again.\n'
        : 'The live release changed during this script. Run the whole script again.\n');
    }
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
export async function dataReady(scope: Page | Locator, timeout = 5_000): Promise<'ready' | 'error'> {
  const root = typeof (scope as Page).goto === 'function' ? (scope as Page).locator(':root') : scope as Locator;
  const views = root.locator('[data-sw-data]');
  await views.first().waitFor({ state: 'attached', timeout });
  await root.locator('[data-sw-data="loading"]').first().waitFor({ state: 'detached', timeout }).catch(async () => {
    if (await root.locator('[data-sw-data="loading"]').count()) throw new Error(`dataReady: a data view was still loading after ${timeout / 1000} s`);
  });
  return (await root.locator('[data-sw-data="error"]').count()) ? 'error' : 'ready';
}

export { ready };
