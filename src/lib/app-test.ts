import { randomUUID } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { testAddressOrder } from './test-connectivity.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { describeReport, type CheckFailure, type ReportCheck } from './test-report.js';
import type { APIRequestContext, BrowserContext, LaunchOptions, Locator, Page } from '@playwright/test';
import { loadProjectConfig } from './config.js';
import type { TestTarget } from './test-target.js';
import { collectFiles } from './files.js';
import { hashFiles } from './base-files.js';
import { describeSweep, forgetRecord, sweepAccounts } from './form-accounts.js';
import { openPreviewControl, openProductionControl, type TestControl } from './test-control.js';
import { loadPreviewRecord } from './preview-record.js';
import { browserStoppedMessage, ready, signIn, signOut, signUp, verify, type Attempt, type FormAdapter, type FormControl, type FormHost, type Person, type SignInOptions, type SignUpOptions } from './form-auth.js';
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
 *  - missing-contract: 400 DATA_CONTRACT_MISSING (the request did not supply a digest);
 *  - malformed: 400/405/413/415, or 403 DATA_ORIGIN_FORBIDDEN (the request is wrong; it proves nothing about access);
 *  - stale-contract: 409 DATA_CONTRACT_MISMATCH (the app changed since the contract was read; it proves nothing);
 *  - error: anything else, such as 409 DATA_CONFLICT (a unique-key conflict). */
export type DataKind = 'ok' | 'empty' | 'refused' | 'missing-or-refused' | 'missing-contract' | 'malformed' | 'stale-contract' | 'error';
export interface DataResult {
  status: number;
  kind: DataKind;
  data: unknown;
  error: string | null;
  message: string | null;
  access?: { filtered: true };
  current_contract_digest?: string;
}
type Who = Page | BrowserContext | APIRequestContext;

/** One check's outcome, including whether a prerequisite kept it from running. */
export interface Check extends ReportCheck { ms: number }
export interface CheckOptions { expected?: string; requires?: { name: string; passed: boolean } }
type MarkStep = (step: string, evidence?: string) => void;

function describeCheckFailure(message: string, expected: string, step: string, evidence: string | undefined, pageUrl?: string): CheckFailure {
  const detail = (pattern: RegExp) => message.match(pattern)?.[1]?.trim();
  const observed = detail(/^Received(?: \w+)?: *(.*)$/m);
  const header = message.split('\n').find(line => line.trim())?.trim() || 'The check did not finish.';
  const artifact = detail(/\b(HTTP [1-5][0-9]{2}(?: [A-Z][A-Z_0-9]+)?)/) ?? detail(/^(?:Locator|Selector): *(.*)$/mi)
    ?? evidence ?? pageUrl;
  const singleLine = (value: string) => scrub(value).replace(/\s+/g, ' ').trim().slice(0, 500);
  return {
    expected: singleLine(detail(/^Expected(?: \w+)?: *(.*)$/m) ?? expected),
    happened: singleLine(observed ? `Received ${observed}.` : header),
    step: singleLine(step),
    ...(artifact ? { evidence: singleLine(artifact) } : {}),
  };
}
/** What a result file was run against. */
export interface RunIdentity { project_id: string; environment: string; preview_session_id: string | null; origin: string; script: string | null }
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

/** Package manifests and lockfiles: installing a test or dev tool rewrites them and nothing else. */
const PACKAGE_MANIFESTS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']);
/** Changed files split into the app's own and the package manifests (a note, not a refusal). */
export function splitManifests(changed: string[]): { app: string[]; manifests: string[] } {
  return { app: changed.filter(file => !PACKAGE_MANIFESTS.has(file)), manifests: changed.filter(file => PACKAGE_MANIFESTS.has(file)) };
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
export function classifyData(status: number, raw: unknown, operation?: string): DataResult {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const error = typeof body?.error === 'string' ? body.error : null;
  const message = typeof body?.message === 'string' ? body.message : null;
  const data = body?.data ?? null;
  const access = body?.access as { filtered?: unknown } | undefined;
  const digest = body?.current_contract_digest;
  const writing = operation === 'create' || operation === 'update' || operation === 'delete';
  let kind: DataKind = 'error';
  if (status === 200 && !error) {
    if (writing && typeof body?.changes === 'number') kind = 'ok';
    else if (body && Object.hasOwn(body, 'data')) kind = data === null || (Array.isArray(data) && !data.length) ? 'empty' : 'ok';
  } else if (status === 400 && error === 'DATA_CONTRACT_MISSING') kind = 'missing-contract';
  else if (status === 409 && error === 'DATA_CONTRACT_MISMATCH') kind = 'stale-contract';
  else if ([400, 405, 413, 415].includes(status) || error === 'DATA_ORIGIN_FORBIDDEN') kind = 'malformed';
  else if ((status === 401 || status === 403) && error) kind = 'refused';
  else if (status === 404 && error === 'DATA_NOT_FOUND' && (operation === undefined || operation === 'update' || operation === 'delete')) kind = 'missing-or-refused';
  return {
    status, kind, data, error, message,
    ...(status === 200 && access?.filtered === true ? { access: { filtered: true } } : {}),
    ...(kind === 'stale-contract' && typeof digest === 'string' ? { current_contract_digest: digest } : {}),
  };
}

export class AppTest {
  readonly origin: string;
  readonly release: string;
  readonly checks: Check[] = [];
  private readonly host: FormHost;
  private readonly started = new Date();
  private finished = false;
  private stopped = false;

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
      // Installing test or dev tools rewrites only the package manifests: a note, never a refusal that
      // forces a redeploy. Any other changed file still refuses.
      const { app: changedApp, manifests } = splitManifests(local?.changed ?? []);
      if (local && manifests.length) {
        local.changed = changedApp;
        process.stderr.write(`Note: ${manifests.join(', ')} changed since the last ${preview ? 'preview save' : 'deploy'}. Installing test tools changes only these, so the tests run; if you changed the app's dependencies, ${preview ? 'save the preview' : 'deploy'} first.\n`);
      }
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
    // Failure output keeps the path of this app's own pages (test-diagnostics scrub).
    process.env.SW_TEST_ORIGIN = target.origin;
    for (const line of describeSweep(await sweepAccounts(control, root), 'Before this script')) process.stderr.write(line + '\n');
    // One result file per script (tests/app-check.mjs → .somewhere/app-check.json), so two scripts never overwrite each other.
    const scriptName = process.argv[1] ? basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') : 'app-check';
    const app = new AppTest(root, control, resolve(root, options.results ?? join('.somewhere', `${scriptName}${preview ? '-preview' : ''}.json`)));
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
    return classifyData(response.status(), body, request.operation);
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
    if (result.kind === 'malformed' || result.kind === 'missing-contract' || result.kind === 'stale-contract') throw new Error(`expectRefused: ${said}: the request was malformed or the app's contract changed, so nothing ran and this proves nothing about access.`);
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

  /** Run one named check unless its prerequisite did not pass. Use at() inside a
   *  check that has several steps. `somewhere test --failed` reruns the whole script. */
  async check(label: string, work: (at: MarkStep) => unknown | Promise<unknown>, options: CheckOptions = {}): Promise<boolean> {
    // The name is recorded and printed scrubbed: a check named after a password never stores it.
    const name = scrub(label);
    if (this.stopped) { this.checks.push({ name, ok: false, ms: 0, skipped: 'after-failure' }); return false; }
    if (options.requires && !options.requires.passed) {
      this.checks.push({ name, ok: false, ms: 0, skipped: 'prerequisite', error: `Requires “${scrub(options.requires.name)}”, which did not pass.` });
      return false;
    }
    const start = performance.now();
    let step = label;
    let evidence: string | undefined;
    try {
      await work((current, artifact) => { step = current; evidence = artifact; });
      this.checks.push({ name, ok: true, ms: Math.round(performance.now() - start) });
      return true;
    }
    catch (error) {
      // Nothing about the failure is printed before every secret it could carry is registered and the whole
      // diagnostic is scrubbed: emailed links, remembered passwords or tokens, session cookies.
      await this.rememberPageSecrets();
      const pages = await Promise.all([...this.host.pages].map(pageState));
      const stopped = [...this.host.pages].map((page) => browserStoppedMessage(page, error)).find(Boolean);
      const message = stopped ?? scrub(error instanceof Error ? error.message : String(error));
      const failure = describeCheckFailure(message, options.expected ?? name, step, evidence,
        [...this.host.pages].find(page => !page.isClosed())?.url() ?? this.origin);
      const detail = message.split('\n').slice(0, 12).join('\n') + pages.map((state, i) => `\npage ${i + 1}: ${state}`).join('');
      this.checks.push({ name, ok: false, ms: Math.round(performance.now() - start), error: detail, failure });
      this.stopped = process.env.SW_TEST_FAIL_FAST === '1';
      return false;
    }
  }

  /** Confirm the release did not change, delete this script's sign-up accounts by exact id, write
   *  the result once, print one summary, and set a non-zero exit code if anything failed or was skipped. */
  async finish(): Promise<{ passed: number; failed: number; file: string }> {
    if (this.finished) throw new Error('finish() already ran');
    this.finished = true;
    const preview = this.control.environment === 'preview';
    let ended = '';
    const live = await this.control.currentRelease().catch((error: unknown) => { ended = error instanceof Error ? error.message : ''; return null; });
    if (live !== this.release) this.checks.push({ name: preview ? 'the preview stayed on the same saved version during the script' : 'the release stayed the same during the script', ok: false, ms: 0,
      error: preview
        ? (live ? `the preview was saved again during the script (${this.release} → ${live}); these results describe no single version` : `${ended || 'the preview could not be confirmed at the end'}; nothing ran against production`)
        : live ? `the live release changed from ${this.release} to ${live} during the script; these results describe no single release` : (ended || 'the live release could not be confirmed at the end') });
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
    for (const check of this.checks) {
      if (!check.ok && !check.skipped && !check.failure) {
        check.failure = describeCheckFailure(check.error ?? '', check.name, check.name, this.origin);
      }
    }
    const passed = this.checks.filter(check => check.ok).length;
    const failed = this.checks.filter(check => !check.ok && !check.skipped).length;
    mkdirSync(dirname(this.resultsPath), { recursive: true });
    writeFileSync(this.resultsPath, JSON.stringify({ identity: this.identity(), origin: this.origin, environment: this.control.environment, ...(preview ? { preview_session_id: this.target.previewSessionId } : {}), release: this.release,
      started: this.started.toISOString(), finished: new Date().toISOString(), passed, failed, checks: this.checks.map((check) => ({ ...check, ...(check.error ? { error: scrub(check.error) } : {}) })) }, null, 2) + '\n');
    // The result: failures first, one line each, then passes, one summary line, what to do next and (after a
    // failure, or with --verbose) the result file relative to the project. Under `somewhere test` the runner prints
    // it for every script together, so this script hands its checks over instead of printing them.
    const reported: ReportCheck[] = this.checks.map(({ ms, ...check }) => ({ ...check,
      ...(check.error ? { error: scrub(check.error) } : {}) }));
    const resultFile = relative(this.root, this.resultsPath);
    const handOver = process.env.SW_TEST_REPORT;
    if (handOver) writeFileSync(handOver, JSON.stringify({ checks: reported, resultFile }) + '\n');
    else {
      const verbose = process.argv.includes('--verbose') || process.env.SW_TEST_VERBOSE === '1';
      const script = process.argv[1] ? relative(this.root, resolve(process.argv[1])) : 'this script';
      process.stdout.write(describeReport([{ script, checks: reported, resultFile }], { verbose }).join('\n') + '\n');
    }
    // After the version changed there is no same version to rerun on.
    if (live !== this.release) {
      process.stdout.write(preview
        ? 'The preview changed or closed during this script. Save it again with `somewhere preview` (or open a new one if it closed), then run the whole script again.\n'
        : 'The live release changed during this script. Run the whole script again.\n');
    }
    // A skipped check is not a pass either: the script exits non-zero.
    if (failed || !this.checks.length || this.checks.some((check) => check.skipped)) process.exitCode = 1;
    return { passed, failed, file: this.resultsPath };
  }
}

/** Open a linked project for a plain script: reads its live origin, release and data contract. */
export function openAppTest(options?: OpenOptions): Promise<AppTest> { return AppTest.open(options); }

export { captureResponses, type Captured } from './test-response-capture.js';

/** Wait until the page's data views have finished loading: the starter marks each with
 *  data-sw-data="loading" | "ready" | "error". Signed-in is not "the list has loaded". */
export async function dataReady(scope: Page | Locator, timeout = 5_000): Promise<'ready' | 'error'> {
  const root = typeof (scope as Page).goto === 'function' ? (scope as Page).locator(':root') : scope as Locator;
  const views = root.locator('[data-sw-data]');
  try {
    await views.first().waitFor({ state: 'attached', timeout });
  } catch (error) {
    const page = root.page();
    if (error instanceof Error && error.name === 'TimeoutError'
        && page.url() !== 'about:blank'
        && await page.evaluate('document.readyState !== "loading" && !!document.body').catch(() => false)) {
      throw new Error('The page loaded without the expected [data-sw-data] marker, which your app sets on the data view to "loading", "ready", or "error" as shown in `somewhere test --help`.');
    }
    throw error;
  }
  await root.locator('[data-sw-data="loading"]').first().waitFor({ state: 'detached', timeout }).catch(async () => {
    if (await root.locator('[data-sw-data="loading"]').count()) throw new Error(`dataReady: a data view was still loading after ${timeout / 1000} s`);
  });
  return (await root.locator('[data-sw-data="error"]').count()) ? 'error' : 'ready';
}

export { ready };
