import type { TestInfo } from '@playwright/test';
const secrets = new Set<string>();
export function rememberSecrets(...values: string[]): void { for (const value of values) if (value) secrets.add(value); }
export function scrub(value: string): string {
  for (const secret of secrets) value = value.split(secret).join('[redacted]');
  return value.replace(/\u001b\[[0-9;]*m/g, '').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|smt_[A-Za-z0-9_-]+/g, '[redacted]');
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
