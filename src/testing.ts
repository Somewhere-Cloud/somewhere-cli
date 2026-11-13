// Node 22.19+: native fetch, cookie storage and TypeScript; no test dependencies.
export class UserSession {
  readonly origin: string;
  private cookies = new Map<string, string>();
  constructor(baseUrl: string) { this.origin = new URL(baseUrl).origin; }
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error('Fixture requests must stay on the app origin');
    const headers = new Headers(init.headers);
    headers.set('Origin', this.origin);
    headers.set('Cookie', [...this.cookies].map(([k, v]) => k + '=' + v).join('; '));
    const response = await fetch(url, { ...init, headers, redirect: 'error' });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const split = pair.indexOf('=');
      this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  }
  post(path: string, body: unknown): Promise<Response> {
    return this.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  // Pass the deployed browser client's contract digest when the app declares client data.
  data(table: string, contract: string, request: DataRequest): Promise<Response> {
    return this.post('/__sw/data', { ...request, table, contract });
  }
}
export type DataRequest =
  | { operation: 'list'; limit?: number; after?: string | number; where?: Record<string, unknown> }
  | { operation: 'get' | 'delete'; id: string | number }
  | { operation: 'create'; values: Record<string, unknown> }
  | { operation: 'update'; id: string | number; values: Record<string, unknown> };

export async function expectStatus(response: Response, expected: number): Promise<void> {
  if (response.status !== expected) throw new Error('Expected HTTP ' + expected + ', received ' + response.status);
}
export async function expectRefusal(response: Response, status: 401 | 403, code: string): Promise<void> {
  await expectStatus(response, status);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('error' in body) || body.error !== code) {
    throw new Error('Refusal did not have the exact expected error code: ' + code);
  }
}
export async function signIn(baseUrl: string, email: string, password: string): Promise<UserSession> {
  const session = new UserSession(baseUrl);
  const response = await session.post('/api/auth/login', { email, password });
  await expectStatus(response, 200);
  const body = await response.json() as { cookie_session?: boolean };
  if (!body.cookie_session) throw new Error('Sign-in did not establish a cookie session');
  return session;
}
export async function createUser(baseUrl: string): Promise<UserSession> {
  const session = new UserSession(baseUrl);
  // Reserved platform test domain: no real recipient, no admin credential.
  const email = 'starter-' + crypto.randomUUID() + '@fixture.test.somewhere.site';
  const password = 'Fixture!9-' + crypto.randomUUID();
  const response = await session.post('/api/auth/signup', { email, password });
  await expectStatus(response, 200);
  const body = await response.json() as { cookie_session?: boolean };
  if (!body.cookie_session) throw new Error('Signup did not establish a cookie session');
  return session;
}
// Structurally compatible with Playwright Page; no browser dependency required.
interface BrowserPage { locator(selector: string): { waitFor(options: { state: 'visible' }): Promise<void> } }
export function waitForApp(page: BrowserPage, state: 'ready' | 'signed-in' | 'signed-out' = 'ready'): Promise<void> {
  const selector = state === 'ready' ? '[data-app-state="signed-in"], [data-app-state="signed-out"]' : '[data-app-state="' + state + '"]';
  return page.locator(selector).waitFor({ state: 'visible' });
}

// Lazy project-local Playwright resolution keeps UserSession dependency-free.
export { test, expect, expectRefused, data, ready, type RefusalOptions, type TestUser, type Person, type SignUpOptions, type SignInOptions, type FormSteps, type CodeSteps } from './lib/playwright-fixtures.js';
