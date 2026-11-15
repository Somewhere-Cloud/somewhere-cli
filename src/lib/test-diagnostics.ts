import type { TestInfo } from '@playwright/test';
import { span } from './test-timeline.js';
const secrets = new Set<string>();
export function rememberSecrets(...values: string[]): void { for (const value of values) if (value) secrets.add(value); }
/** True when any registered secret (password, code, cookie, credential, session) appears in `text`. */
export function containsSecret(text: string): boolean {
  for (const secret of secrets) if (secret.length >= 4 && text.includes(secret)) return true;
  return false;
}
export function scrub(value: string): string {
  for (const secret of secrets) value = value.split(secret).join('[redacted]');
  // Preview tool credentials (swpt.<project>.<preview>.<secret>) and preview browser sessions
  // (draft_….rel_….<uuid>), whether or not this process registered them.
  value = value.replace(/swpt\.[A-Za-z0-9._-]+/g, '[redacted]').replace(/draft_[0-9a-f-]{36}\.rel_[A-Za-z0-9_-]+\.[0-9a-f-]{36}/gi, '[redacted]');
  return value.replace(/https?:\/\/[^\s<>"']+/g, raw => { try { const url = new URL(raw); return url.origin + '/[redacted-url]'; } catch { return '[redacted-url]'; } }).replace(/([?&](?:token|code|secret|key|password|access_token|refresh_token)=)[^&\s]+/gi, '$1[redacted]').replace(/(\/(?:reset-password|reset|verify|magic|invite)\/)[^\s?#]+/gi, '$1[redacted]').replace(/\u001b\[[0-9;]*m/g, '').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|smt_[A-Za-z0-9_-]+/g, '[redacted]');
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
export interface Diagnostics { release?: string; request?: RequestEvidence; screenshot?: string; timings: Record<string, number> }
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
