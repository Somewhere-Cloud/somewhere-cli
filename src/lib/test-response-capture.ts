import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export function privateMarker(): string { return 'sw-test-' + randomUUID(); }

export interface Captured { url: string; status: number; contentType: string; body: string }
/** Record every response this page receives (documents, scripts, data) with its body, so a
 *  privacy check can wait for all of them and say exactly where a secret appeared. */
export function captureResponses(page: Page) {
  const pending: Promise<Captured | null>[] = [];
  const listener = (response: import('@playwright/test').Response) => {
    const url = new URL(response.url());
    pending.push(response.text().then(body => ({ url: url.origin + url.pathname, status: response.status(), contentType: response.headers()['content-type'] ?? '', body })).catch(() => null));
  };
  page.on('response', listener);
  return {
    /** Every captured response, after each body has been read. */
    async all(): Promise<Captured[]> { return (await Promise.all(pending)).filter((c): c is Captured => c !== null); },
    /** Where `secret` appeared: URL, status, content type and the text around it. Use a unique value you planted. */
    async find(secret: string): Promise<{ url: string; status: number; contentType: string; around: string }[]> {
      return (await this.all()).filter(c => c.body.includes(secret)).map(c => {
        const at = c.body.indexOf(secret);
        return { url: c.url, status: c.status, contentType: c.contentType, around: c.body.slice(Math.max(0, at - 60), at + secret.length + 60) };
      });
    },
    stop(): void { page.off('response', listener); },
  };
}


/** Report where a marker appeared without embedding response bodies in test output. */
export async function assertNoLeak(marker: string, responses: Iterable<Response | Captured>): Promise<void> {
  if (!marker) throw new Error('Use a nonempty test marker.');
  for (const response of responses) {
    const body = response instanceof Response ? await response.clone().text() : response.body;
    if (body.includes(marker)) {
      const path = new URL(response.url).pathname.replaceAll(marker, ':marker');
      throw new Error(`Private test marker appeared in ${path} (HTTP ${response.status}).`);
    }
  }
}
