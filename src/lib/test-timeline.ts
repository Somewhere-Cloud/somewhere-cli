import { appendFileSync } from 'node:fs';
import type { Page, Request } from '@playwright/test';

// A metadata-only timeline of one `somewhere test` run, written when SW_TEST_TIMELINE names a file:
// one JSON line per event, from the CLI, the Playwright runner and every worker. Times are
// performance.timeOrigin + performance.now() in milliseconds (monotonic within each process, on the
// shared wall clock across processes). Never bodies, headers, cookies, tokens, codes or query strings.

type Meta = Record<string, string | number | boolean | null | undefined>;
const now = (): number => Math.round((performance.timeOrigin + performance.now()) * 10) / 10;

export function timelineEnabled(): boolean { return Boolean(process.env.SW_TEST_TIMELINE); }

export function mark(event: string, meta: Meta = {}, at = now()): void {
  const path = process.env.SW_TEST_TIMELINE;
  if (!path) return;
  appendFileSync(path, JSON.stringify({ t: at, pid: process.pid, event, ...meta }) + '\n');
}

export async function span<T>(event: string, meta: Meta, work: () => Promise<T>): Promise<T> {
  if (!timelineEnabled()) return work();
  mark(event + ':start', meta);
  try { return await work(); } finally { mark(event + ':end', meta); }
}

/** The process start, as the first event of this process. */
export function markProcessStart(role: string): void { mark('process:start', { role }, Math.round(performance.timeOrigin * 10) / 10); }

const tracked = new WeakSet<Page>();
// The path only; capability segments (reset, verify, magic, invite links) are cut.
const pathOf = (raw: string): string => { try { return new URL(raw).pathname.replace(/(\/(?:reset-password|reset|verify|magic|invite)\/)[^/]+/gi, '$1[redacted]'); } catch { return '[unparsed]'; } };
/** Navigations (start, DOM ready, load) and the page's document/fetch requests (start, end, status). */
export function trackPage(page: Page, test: string): void {
  if (!timelineEnabled() || tracked.has(page)) return;
  tracked.add(page);
  const relevant = (request: Request): boolean => ['document', 'fetch', 'xhr'].includes(request.resourceType());
  const meta = (request: Request): Meta => ({ test, kind: request.resourceType(), method: request.method(), path: pathOf(request.url()) });
  page.on('request', request => { if (relevant(request)) mark(request.resourceType() === 'document' ? 'nav:start' : 'http:start', meta(request)); });
  page.on('requestfinished', request => {
    if (!relevant(request)) return;
    void request.response().then(response => mark(request.resourceType() === 'document' ? 'nav:response' : 'http:end', { ...meta(request), status: response?.status() ?? 0 })).catch(() => mark('http:end', { ...meta(request), status: -1 }));
  });
  page.on('requestfailed', request => { if (relevant(request)) mark('http:failed', meta(request)); });
  page.on('domcontentloaded', () => mark('nav:domcontentloaded', { test }));
  page.on('load', () => mark('nav:load', { test }));
}
