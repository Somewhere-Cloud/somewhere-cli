import type { TestInfo } from '@playwright/test';
const secrets = new Set<string>();
export function rememberSecrets(...values: string[]): void { for (const value of values) if (value) secrets.add(value); }
export function scrub(value: string): string {
  for (const secret of secrets) value = value.split(secret).join('[redacted]');
  return value.replace(/https?:\/\/[^\s<>"']+/g, raw => { try { const url = new URL(raw); return url.origin + '/[redacted-url]'; } catch { return '[redacted-url]'; } }).replace(/([?&](?:token|code|secret|key|password|access_token|refresh_token)=)[^&\s]+/gi, '$1[redacted]').replace(/(\/(?:reset-password|reset|verify|magic|invite)\/)[^\s?#]+/gi, '$1[redacted]').replace(/\u001b\[[0-9;]*m/g, '').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|smt_[A-Za-z0-9_-]+/g, '[redacted]');
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
  try { return await work(); } finally { const report = diagnostics(info); report.timings[name] = (report.timings[name] ?? 0) + performance.now() - start; }
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
