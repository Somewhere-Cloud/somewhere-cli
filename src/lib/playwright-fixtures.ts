import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { APIRequestContext, APIResponse, BrowserContext, Locator, Page, TestType, PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions } from '@playwright/test';
import { ApiClient } from './client.js';
import { getToken, loadProjectConfig } from './config.js';
import { buildStorageState, createTestIdentities, expiryOf, productionOrigin, type IssuedIdentity } from './test-identities.js';
import { diagnostics, rememberSecrets, scrub, safeError, timed } from './test-diagnostics.js';
import type { TestInfo } from '@playwright/test';
import type { DataRequest } from '../testing.js';

export interface TestUser { id: string; email: string; page: Page; request: APIRequestContext }
interface Fixtures { _evidence: void; newUser: () => Promise<TestUser>; anonymous: APIRequestContext }
type RunnerTest = TestType<PlaywrightTestArgs & PlaywrightTestOptions & Fixtures, PlaywrightWorkerArgs & PlaywrightWorkerOptions>;
let loaded: { test: RunnerTest; expect: typeof import('@playwright/test').expect } | undefined;
const digests = new WeakMap<APIRequestContext, string | null>();

function runner() {
  if (loaded) return loaded;
  const require = createRequire(join(process.cwd(), 'package.json'));
  let pw: typeof import('@playwright/test');
  try { pw = require('@playwright/test') as typeof import('@playwright/test'); }
  catch { throw new Error('Install project test dependencies: npm install -D @playwright/test @somewhere-cloud/cli'); }
  const test = pw.test.extend<Fixtures>({
    _evidence: [async ({}, use, info) => {
      try { await use(); } finally {
        const report = diagnostics(info);
        await info.attach('somewhere-diagnostics', { body: Buffer.from(JSON.stringify({ ...report, title: scrub(info.title), errors: info.errors.map(error => safeError(error.message ?? 'Test failed')), secretAudit: 'issued values scrubbed before reporting' })), contentType: 'application/json' });
      }
    }, { auto: true }],
    newUser: async ({ browser }, use, info) => {
      const projectId = loadProjectConfig()?.project_id;
      if (!projectId) throw new Error('Run somewhere test from a linked project folder.');
      const client = new ApiClient(getToken());
      const urls = await timed(info, 'target lookup', () => client.call<{ prod_fallback: string }>('GET', `/projects/${encodeURIComponent(projectId)}/urls`));
      const { origin, host } = productionOrigin(urls.prod_fallback);
      const map = await timed(info, 'access map', () => client.call<{ release: { id: string }; browser_data: { contract_digest: string | null } }>('GET', '/db/access-map', undefined, { project_id: projectId }));
      diagnostics(info).release = map.release.id;
      const owned: IssuedIdentity[] = [];
      const contexts: BrowserContext[] = [];
      const partialIds: string[] = [];
      try {
        await use(async () => {
          let created: Awaited<ReturnType<typeof createTestIdentities>>;
          try { created = await timed(info, 'test-user creation', () => createTestIdentities(client, projectId, 'user', 1, 'pw')); }
          catch (error) {
            partialIds.push(...((error as { createdIds?: string[] }).createdIds ?? []));
            owned.push(...((error as { issued?: IssuedIdentity[] }).issued ?? []));
            throw error;
          }
          owned.push(...created.issued);
          const issued = created.issued[0];
          rememberSecrets(issued.access_token, issued.refresh_token);
          const context = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin }, storageState: buildStorageState(origin, host, issued, expiryOf(issued, created.receivedAt)) });
          contexts.push(context);
          constrain(context.request, origin, info);
          digests.set(context.request, map.browser_data.contract_digest);
          const page = await timed(info, 'page creation', () => context.newPage());
          page.on('load', () => { void page.evaluate<number>("performance.getEntriesByType('navigation')[0]?.duration ?? 0").then(ms => { diagnostics(info).timings['page load'] = ms; }).catch(() => {}); });
          return { id: issued.user.id, email: issued.user.email, page, request: context.request };
        });
      } finally {
        const failures: string[] = [];
        for (const context of contexts) try {
          rememberSecrets(...(await context.cookies()).map(cookie => cookie.value));
          if (info.status !== info.expectedStatus) {
            const page = context.pages()[0];
            if (page && !/auth|login|signup|reset/i.test(new URL(page.url()).pathname)) {
              const path = info.outputPath('failure.png');
              await page.screenshot({ path, mask: [page.locator('input, textarea')] });
              diagnostics(info).screenshot = path;
            }
          }
        } catch { failures.push('Failure screenshot capture failed'); } finally {
          try { await context.close(); } catch { failures.push('Browser context cleanup failed'); }
        }
        const ids = [...new Set([...owned.map(identity => identity.user.id), ...partialIds])];
        if (ids.length) {
          try {
            await timed(info, 'test-user deletion', () => client.call('DELETE', '/auth/test-users', { project_id: projectId, ids }));
            const remaining = await timed(info, 'cleanup confirmation', () => client.call<{ identities: { id: string }[] }>('GET', '/auth/test-users', undefined, { project_id: projectId }));
            if (remaining.identities.some(identity => ids.includes(identity.id))) failures.push('Test user cleanup unconfirmed');
          } catch { failures.push('Test user cleanup unconfirmed; app rows remain'); }
        }
        if (failures.length) throw new Error(failures.join('; '));
      }
    },
    anonymous: async ({ browser }, use, info) => {
      const projectId = loadProjectConfig()?.project_id;
      if (!projectId) throw new Error('Run from a linked project folder.');
      const client = new ApiClient(getToken());
      const urls = await timed(info, 'target lookup', () => client.call<{ prod_fallback: string }>('GET', `/projects/${encodeURIComponent(projectId)}/urls`));
      const { origin } = productionOrigin(urls.prod_fallback);
      const map = await timed(info, 'access map', () => client.call<{ release: { id: string }; browser_data: { contract_digest: string | null } }>('GET', '/db/access-map', undefined, { project_id: projectId }));
      diagnostics(info).release = map.release.id;
      const context = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
      constrain(context.request, origin, info);
      digests.set(context.request, map.browser_data.contract_digest);
      try { await use(context.request); } finally { rememberSecrets(...(await context.cookies()).map(cookie => cookie.value)); await context.close(); }
    },
  });
  loaded = { test, expect: pw.expect };
  return loaded;
}

// Patch the shared-cookie client, preserving its identity and cookie rotation.
function constrain(client: APIRequestContext, origin: string, info: TestInfo): void {
  for (const method of ['fetch'] as const) {
    const original = client[method].bind(client) as (url: string, options?: Record<string, unknown>) => Promise<APIResponse>;
    Object.defineProperty(client, method, { value: async (path: string, options: Record<string, unknown> = {}) => {
      const url = new URL(path, origin);
      if (url.origin !== origin) throw new Error('Fixture requests must stay on the app origin');
      const headers = new Headers(options.headers as Record<string, string> | undefined);
      if (headers.has('Authorization')) throw new Error('Fixture clients do not accept Authorization headers');
      headers.set('Origin', origin);
      const response = await timed(info, 'app requests', () => original(url.href, { ...options, headers: Object.fromEntries(headers), maxRedirects: 0 }));
      rememberSecrets(...(await client.storageState()).cookies.map(cookie => cookie.value));
      let code = 'none';
      if (response.status() >= 400) {
        try { const body = await response.json() as { error?: unknown }; if (typeof body.error === 'string' && /^[A-Z_]+$/.test(body.error)) code = body.error; } catch {}
      }
      diagnostics(info).request = { method: String(options.method ?? 'GET').toUpperCase(), path: scrub(url.pathname), status: response.status(), code };
      return response;
    } });
  }
}

export const test: RunnerTest = new Proxy((() => {}) as unknown as RunnerTest, {
  apply: (_target, receiver, args) => Reflect.apply(runner().test, receiver, args),
  get: (_target, key) => Reflect.get(runner().test, key),
});
export const expect: typeof import('@playwright/test').expect = new Proxy((() => {}) as unknown as typeof import('@playwright/test').expect, {
  apply: (_target, receiver, args) => Reflect.apply(runner().expect, receiver, args),
  get: (_target, key) => Reflect.get(runner().expect, key),
});
export async function expectRefused(response: APIResponse, status: number, code: string): Promise<void> {
  const actual = response.status();
  if ([400, 409].includes(actual) || [400, 409].includes(status)) throw new Error(`HTTP ${actual}: malformed request or contract mismatch proves no access refusal`);
  const body = await response.json() as { error?: unknown };
  if (actual !== status || body.error !== code) throw new Error(`Expected HTTP ${status} ${code}; received HTTP ${actual} ${typeof body.error === 'string' && /^[A-Z_]+$/.test(body.error) ? body.error : 'unknown error code'}`);
}
export function data(client: APIRequestContext, table: string, request: DataRequest): Promise<APIResponse> {
  if (!digests.has(client)) throw new Error('Use a newUser or anonymous fixture client');
  return client.post('/__sw/data', { data: { ...request, table, contract: digests.get(client) ?? '' } });
}
export async function ready(page: Page, state: 'ready' | 'signed-in' | 'signed-out' | Locator = 'ready'): Promise<void> {
  const locator = typeof state === 'string' ? page.locator(state === 'ready' ? '[data-app-state="signed-in"], [data-app-state="signed-out"]' : `[data-app-state="${state}"]`) : state;
  await locator.waitFor({ state: 'visible' });
}
