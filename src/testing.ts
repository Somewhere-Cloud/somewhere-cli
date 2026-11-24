export { UserSession, signIn, createUser, expectStatus, expectRefusal, type DataRequest } from './lib/test-session.js';

// Structurally compatible with Playwright without loading its browser.
interface ReadyLocator {
  first?(): ReadyLocator;
  waitFor(options: { state: 'visible' }): Promise<void>;
}
interface BrowserPage { locator(selector: string): ReadyLocator }
export function waitForApp(page: BrowserPage, state: 'ready' | 'signed-in' | 'signed-out' = 'ready'): Promise<void> {
  const values = state === 'ready' ? ['signed-in', 'signed-out'] : [state];
  const matches = values.flatMap(value => [`html[data-sw-auth="${value}"]`, `[data-app-state="${value}"]`]);
  const locator = page.locator(matches.join(', '));
  return (locator.first?.() ?? locator).waitFor({ state: 'visible' });
}

// Lazy project-local Playwright resolution keeps UserSession dependency-free.
export { test, expect, expectRefused, data, ready, type RefusalOptions, type TestUser, type NewUserOptions, type Person, type SignUpOptions, type SignInOptions, type FormSteps, type CodeSteps } from './lib/playwright-fixtures.js';

export { openTestApp, type TestApp, type TestActor } from './lib/testing-app.js';
export { assertNoLeak, captureResponses } from './lib/test-response-capture.js';
export type { TestJob, TestJobOptions, TestJobTarget } from './lib/testing-jobs.js';
