import { ApiClient } from './client.js';
import { getToken, loadProjectConfig } from './config.js';
import { fixtureTestTarget, type TestTarget } from './test-target.js';
import type { PlaywrightStorageState } from './test-identities.js';

// Node 22.19+: native fetch, cookie storage and TypeScript; no test dependencies.
export class UserSession {
  readonly origin: string;
  private cookies = new Map<string, string>();
  private target?: Promise<TestTarget>;
  private readonly seed: PlaywrightStorageState;
  constructor(baseUrl: string, options: { target?: TestTarget; storageState?: PlaywrightStorageState } = {}) {
    this.origin = new URL(baseUrl).origin;
    if (options.target && options.target.origin !== this.origin) throw new Error('The test target belongs to a different app.');
    this.target = options.target ? Promise.resolve(options.target) : undefined;
    this.seed = options.storageState ?? { cookies: [], origins: [] };
    for (const cookie of this.seed.cookies) {
      if (cookie.domain === new URL(this.origin).hostname) this.cookies.set(cookie.name, cookie.value);
    }
  }
  /** Standard Playwright state. Treat this value like a signed-in session. */
  storageState(): PlaywrightStorageState {
    const url = new URL(this.origin);
    return {
      cookies: [...this.cookies].map(([name, value]) => {
        const seed = this.seed.cookies.find((cookie) => cookie.name === name && cookie.domain === url.hostname);
        return seed && seed.value === value ? { ...seed }
          : { name, value, domain: url.hostname, path: '/', expires: -1, httpOnly: true, secure: url.protocol === 'https:', sameSite: 'Lax' };
      }),
      origins: structuredClone(this.seed.origins),
    };
  }
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
      if (split <= 0) continue;
      const name = pair.slice(0, split);
      const value = pair.slice(split + 1);
      if (!value || /(?:^|;\s*)max-age=0(?:;|$)/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
  post(path: string, body: unknown): Promise<Response> {
    return this.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  /** Use this session's cookies and the linked app's declared data contract. */
  data(table: string, request: DataRequest): Promise<Response>;
  data(table: string, contract: string, request: DataRequest): Promise<Response>;
  async data(table: string, requestOrContract: DataRequest | string, request?: DataRequest): Promise<Response> {
    if (typeof requestOrContract === 'string') {
      return this.post('/__sw/data', { ...request, table, contract: requestOrContract });
    }
    if (!this.target) {
      const projectId = loadProjectConfig()?.project_id;
      if (!projectId) throw new Error('Use the data helper from a linked project folder.');
      this.target = fixtureTestTarget(new ApiClient(process.env.SW_TEST_TARGET ? null : getToken()), projectId);
    }
    const target = await this.target;
    if (target.origin !== this.origin) throw new Error('This session belongs to a different app than the linked test target.');
    return this.post('/__sw/data', { ...requestOrContract, table, contract: target.contractDigest ?? '' });
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
