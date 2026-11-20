import { FIRST_CLI_PERMISSION } from './first-cli-permission.js';
import type { InitScaffoldFile } from './init-scaffold.js';

// One short, ordinary Playwright script an agent copies and changes: `somewhere test` runs every
// tests/*.mjs and tests/*.cjs script when the project has no tests/**/*.spec.ts. The helpers come
// from @somewhere-cloud/cli/script and work the same from .mjs or .cjs.

const SCRIPT = (privateData: boolean) => `// Change these Playwright checks to match your app. Run after a successful deploy.
// ${FIRST_CLI_PERMISSION}
//   npx @somewhere-cloud/cli deploy && npx @somewhere-cloud/cli test
// Results: .somewhere/app-check.json. Rerun failed scripts with npx @somewhere-cloud/cli test --failed.
import { chromium } from '@playwright/test';
import { openAppTest${privateData ? ', captureResponses, dataReady' : ''} } from '@somewhere-cloud/cli/script';
const app = await openAppTest(); // stops if this folder has changes the live release lacks
const browser = await chromium.launch(app.launchOptions());
const person = async () => {
  const page = await browser.newPage({ baseURL: app.origin });
  page.setDefaultTimeout(5_000); // a deployed app answers in well under a second; never sleep, wait for the thing itself
  return { page, account: await app.signUp(page) };
};
try {
  await app.check('the sign-in page loads', async (at) => {
    const page = await browser.newPage({ baseURL: app.origin });
    try {
      await page.goto('/');
      at('Wait for the signed-out page', '[data-app-state="signed-out"]');
      await page.locator('[data-app-state="signed-out"]').waitFor({ timeout: 5_000 });
    } finally { await page.close(); }
  });
  let ana, ben;
  const needsSignup = { name: 'sign up through the app', passed: false };
  needsSignup.passed = await app.check(needsSignup.name, async () => {
    // Finish both attempts before cleanup, even if one fails.
    const people = await Promise.allSettled([person(), person()]);
    for (const result of people) if (result.status === 'rejected') throw result.reason;
    [ana, ben] = people.map(result => result.value);
  });
  await app.check('the signed-in page shows the account', () => ana.page.getByText(ana.account.email).waitFor(), { requires: needsSignup });
  const roundTrip = 'sign out, then sign back in';
  const signedBackIn = await app.check(roundTrip, async (at) => {
    await app.signOut(ana.page);
    at('Sign back in');
    await app.signIn(ana.page, ana.account);
  }, { requires: needsSignup });
${privateData ? `  await app.check('a note stays private to its owner', async (at) => {
    const secret = 'private ' + crypto.randomUUID();
    at('Create the first person’s note');
    // Controls are found by data-testid, not their words: keep note-title, note-save and note-item
    // on the form field, the save button and each listed note when you rename or restyle them.
    await ana.page.getByTestId('note-title').fill(secret);
    await ana.page.getByTestId('note-save').click();
    await ana.page.getByTestId('note-item').filter({ hasText: secret }).waitFor();
    const seen = captureResponses(ben.page);
    try {
      await ben.page.reload();
      // On the data view, set data-sw-data="loading" while fetching, "ready" once loaded, or "error" if fetching fails.
      at('Wait for the second person’s notes to load', '[data-sw-data]');
      if (await dataReady(ben.page) === 'error') throw new Error('The second person’s notes view reported a loading error.');
      const [leak] = await seen.find(secret);
      if (leak) {
        at('Check the second person’s responses for the note', leak.url);
        throw new Error('The second person received the first person’s note.');
      }
    } finally { seen.stop(); }
    at('Read the note as its owner');
    const owned = await app.data(ana.page, { table: 'notes', operation: 'list', where: { title: secret } });
    const note = owned.data?.[0];
    if (!note) throw new Error('The owner’s request did not return the new note (HTTP ' + owned.status + ').');
    at('Check that the second person cannot read, edit, or delete the note');
    await app.expectRefused(ben.page, { table: 'notes', operation: 'get', id: note.id }, { allowed: ana.page });
    await app.expectRefused(ben.page, { table: 'notes', operation: 'update', id: note.id, values: { title: 'changed' } }, { allowed: ana.page });
    await app.expectRefused(ben.page, { table: 'notes', operation: 'delete', id: note.id }, { allowed: ana.page });
  }, { requires: needsSignup.passed ? { name: roundTrip, passed: signedBackIn } : needsSignup });
` : `  // After adding tables in db/schema.ts, test access with these helpers:
  //   const { data: [task] } = await app.data(ana.page, { table: 'tasks', operation: 'list' });
  //   await app.expectRefused(ben.page, { table: 'tasks', operation: 'get', id: task.id }, { allowed: ana.page });
`}  await app.check('at phone width nothing scrolls sideways', async (at) => {
    await ben.page.setViewportSize({ width: 390, height: 844 });
    await ben.page.reload();
    await ben.page.getByText(ben.account.email).waitFor();
    at('Measure horizontal overflow', app.origin);
    const wide = await ben.page.evaluate(() => [document.documentElement, ...document.querySelectorAll('body *')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1
        && (el === document.documentElement || ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)))
      .map((el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '')));
    if (wide.length) throw new Error('scrolls sideways at 390 px: ' + wide.join(', '));
  }, { requires: needsSignup });
} finally {
  await app.finish(); // confirms the release, deletes the accounts, writes the result once
  await browser.close();
}
`;

/** The starter's example script (auth starters only; the minimal starter has no sign-in form). */
export function starterTests(options: { privateData?: boolean } = {}): InitScaffoldFile[] {
  return [{ path: 'tests/app-check.mjs', content: SCRIPT(Boolean(options.privateData)) }];
}
