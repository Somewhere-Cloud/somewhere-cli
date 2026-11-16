import type { TestInfo } from '@playwright/test';
import { span } from './test-timeline.js';
const secrets = new Set<string>();
export function rememberSecrets(...values: string[]): void { for (const value of values) if (value) secrets.add(value); }
/** True when any registered secret (password, code, cookie, credential, session) appears in `text`. */
export function containsSecret(text: string): boolean {
  for (const secret of secrets) if (secret.length >= 4 && text.includes(secret)) return true;
  return false;
}
/** Signed download, upload and scratch links: everything after the prefix is the credential. */
const SIGNED_PATH = /^\/v1\/(?:fs-signed|upload|scratch)[^/]*/i;
/** A path segment that looks like a credential: long, from a token's alphabet, and either mixing upper case,
 *  lower case and digits (random base64) or 40+ characters (hex tokens). Ids such as UUIDs are kept. */
function tokenShaped(segment: string): boolean {
  if (segment.length < 20 || !/^[A-Za-z0-9._~+=%-]+$/.test(segment)) return false;
  return segment.length >= 40 || (/[a-z]/.test(segment) && /[A-Z]/.test(segment) && /\d/.test(segment));
}
/** A URL in test output. The app's own pages (SW_TEST_ORIGIN) keep their path, so a failure says which page;
 *  the query and fragment are hidden, and so is any credential-shaped segment. Any other address keeps only
 *  its origin. */
function scrubUrl(match: string): string {
  const [, raw, trailing] = /^(.*?)([).,;:!]*)$/.exec(match)!;
  let url: URL;
  try { url = new URL(raw); } catch { return '[redacted-url]' + trailing; }
  let app: string | null = null;
  try { app = process.env.SW_TEST_ORIGIN ? new URL(process.env.SW_TEST_ORIGIN).origin : null; } catch { /* not a URL: no app origin */ }
  if (url.origin !== app) return url.origin + '/[redacted-url]' + trailing;
  const signed = SIGNED_PATH.exec(url.pathname);
  const path = signed ? `${signed[0]}/[redacted]`
    : url.pathname.split('/').map((segment) => tokenShaped(segment) ? '[redacted]' : segment).join('/').replaceAll('%5Bredacted%5D', '[redacted]');
  return url.origin + path + (url.search ? '?[redacted]' : '') + (url.hash ? '#[redacted]' : '') + trailing;
}
export function scrub(value: string): string {
  for (const secret of secrets) value = value.split(secret).join('[redacted]');
  // Preview tool credentials (swpt.<project>.<preview>.<secret>) and preview browser sessions
  // (draft_….rel_….<uuid>), whether or not this process registered them.
  value = value.replace(/swpt\.[A-Za-z0-9._-]+/g, '[redacted]').replace(/draft_[0-9a-f-]{36}\.rel_[A-Za-z0-9_-]+\.[0-9a-f-]{36}/gi, '[redacted]');
  return value.replace(/https?:\/\/[^\s<>"']+/g, scrubUrl).replace(/([?&](?:token|code|secret|key|password|access_token|refresh_token)=)[^&\s]+/gi, '$1[redacted]').replace(/(\/(?:reset-password|reset|verify|magic|invite)\/)[^\s?#]+/gi, '$1[redacted]').replace(/\u001b\[[0-9;]*m/g, '').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|smt_[A-Za-z0-9_-]+/g, '[redacted]');
}
/**
 * Scrub a test's errors IN PLACE, before Playwright writes anything from them. Playwright builds
 * error-context.md from these objects at the end of the test (after the somewhere fixtures' teardown)
 * and sends the same objects to the reporter, so every message, stack, value and matcher snapshot
 * (errorContext) loses each registered secret here, before the first write. (The page snapshot that
 * error-context.md would otherwise add is switched off: PLAYWRIGHT_NO_COPY_PROMPT.)
 */
export function scrubTestErrors(errors: Array<Record<string, unknown>>): void {
  for (const error of errors) {
    for (const key of ['message', 'stack', 'value', 'errorContext', 'snippet']) {
      if (typeof error[key] === 'string') error[key] = scrub(error[key] as string);
    }
    if (error.cause && typeof error.cause === 'object') scrubTestErrors([error.cause as Record<string, unknown>]);
  }
}
export interface RequestEvidence { method: string; path: string; status: number; code: string }
/** `notes`: what cleanup did that the reader should know but that is not a failure (a team deleted with
 *  the run's sign-ups, a closed preview's record dropped); printed under the test, kept in results. */
export interface Diagnostics { release?: string; request?: RequestEvidence; screenshot?: string; timings: Record<string, number>; notes?: string[] }
const reports = new WeakMap<TestInfo, Diagnostics>();
export function diagnostics(info: TestInfo): Diagnostics {
  let report = reports.get(info);
  if (!report) { report = { timings: {} }; reports.set(info, report); }
  return report;
}
export async function timed<T>(info: TestInfo, name: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await span(name, { test: titled(info.project.name, info.title) }, work); } finally { const report = diagnostics(info); report.timings[name] = (report.timings[name] ?? 0) + performance.now() - start; }
}

/** The failure as Playwright reported it (assertion, expected and received, file:line),
 *  with issued credentials, capability URLs and tokens scrubbed and its size bounded. */
export function describeError(error: { message?: string; value?: string; location?: { file: string; line: number; column?: number } }, root = process.cwd()): string {
  const raw = error.message ?? error.value ?? 'Error with no message';
  const message = scrub(raw).replace(/\n{3,}/g, '\n\n').trim();
  const bounded = message.length > 2000 ? message.slice(0, 2000) + ' …(truncated)' : message;
  if (!error.location) return bounded;
  const file = error.location.file.startsWith(root + '/') ? error.location.file.slice(root.length + 1) : error.location.file;
  return `${scrub(file)}:${error.location.line}: ${bounded}`;
}

/** A test title, marked when it ran in the phone pass (somewhere test --phone). */
export function titled(project: string | undefined, title: string): string {
  return project === 'phone' ? `[phone] ${title}` : title;
}
