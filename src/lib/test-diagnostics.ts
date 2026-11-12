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

export function safeError(value: string): string {
  const clean = scrub(value);
  const category = /Timeout|timed out/i.test(clean) ? 'Timeout' : /Cannot find module|Cannot resolve|module not found/i.test(clean) ? 'Module resolution failed' : /SyntaxError|Unexpected token/i.test(clean) ? 'Syntax error' : /expect\(|AssertionError|Expected:/i.test(clean) ? 'Assertion failed' : /test.only/i.test(clean) ? 'Focused test forbidden' : 'Test or setup failed';
  return category;
}
