import { FIRST_CLI_PERMISSION } from './first-cli-permission.js';
import type { InitScaffoldFile } from './init-scaffold.js';

// One short, ordinary Playwright script an agent copies and changes: `somewhere test` runs every
// tests/*.mjs and tests/*.cjs script when the project has no tests/**/*.spec.ts. The helpers come
// from @somewhere-cloud/cli/script and work the same from .mjs or .cjs.

const SCRIPT = (privateData: boolean) => `// tests/app-check.mjs — an ordinary Playwright script for this app: change the checks to match
// what you built. Run it after a successful deploy, never after a refused one:
// ${FIRST_CLI_PERMISSION}
//   npx @somewhere-cloud/cli deploy && npx @somewhere-cloud/cli test
// Tests that need the email inbox work after you claim the app.
// It writes its result once to .somewhere/app-check.json; the exit code is the verdict.
// Independent checks keep running. A check that needs an earlier step reports why it was skipped.
// After a fix, rerun the scripts that failed, each one whole: npx @somewhere-cloud/cli test --failed.
// From a .cjs script: const { openAppTest } = require('@somewhere-cloud/cli/script');
import { chromium } from '@playwright/test';
import { openAppTest${privateData ? ', captureResponses, dataReady' : ''} } from '@somewhere-cloud/cli/script';

const app = await openAppTest(); // stops if this folder has changes the live release lacks
const browser = await chromium.launch(app.launchOptions());
// One person = one browser context, signed up through the app's own form (accounts are
// deleted by exact id in finish()).
const person = async () => {
  const page = await browser.newPage({ baseURL: app.origin });
  page.setDefaultTimeout(5_000); // a deployed app answers in well under a second; never sleep, wait for the thing itself
  return { page, account: await app.signUp(page) };
};
try {
  await app.check('the sign-in page loads', async (at) => {
    const page = await browser.newPage({ baseURL: app.origin });
    try {
      at('Open the sign-in page', app.origin);
      await page.goto('/');
      const selector = '[data-app-state="signed-out"]';
      at('Wait for the signed-out page', selector);
      await page.locator(selector).waitFor({ timeout: 5_000 });
    } finally {
      await page.close();
    }
  });
  let ana, ben;
  const signup = 'sign up through the app';
  const signedUp = await app.check(signup, async () => {
    // Finish both attempts before cleanup, even if one fails.
    const people = await Promise.allSettled([person(), person()]);
    for (const result of people) if (result.status === 'rejected') throw result.reason;
    [ana, ben] = people.map(result => result.value);
  });
  const needsSignup = { name: signup, passed: signedUp };
  await app.check('the signed-in page shows the account', () => ana.page.getByText(ana.account.email).waitFor(), { requires: needsSignup });
  const roundTrip = 'sign out, then sign back in';
  const signedBackIn = await app.check(roundTrip, async (at) => {
    at('Sign out');
    await app.signOut(ana.page);
    at('Sign back in');
    await app.signIn(ana.page, ana.account);
  }, { requires: needsSignup });
${privateData ? `    await app.check('a note stays private to its owner', async (at) => {
      const secret = 'private ' + crypto.randomUUID(); // a unique value: search for it, not a common word
      at('Create the first person’s note');
      await ana.page.getByLabel('Title').fill(secret);
      await ana.page.getByRole('button', { name: 'Add note' }).click();
      await ana.page.getByRole('heading', { name: secret }).waitFor();
      const seen = captureResponses(ben.page);
      try {
        at('Reload the second person’s page', app.origin);
        await ben.page.reload();
        // On the data view, set data-sw-data="loading" while fetching, "ready" when
        // the list has loaded, or "error" if fetching failed. dataReady waits for this marker.
        at('Wait for the second person’s notes to load', '[data-sw-data]');
        if (await dataReady(ben.page) === 'error') throw new Error('The second person’s notes view reported a loading error.');
        at('Check the second person’s responses for the note');
        const leaks = await seen.find(secret);
        if (leaks.length) {
          at('Check the second person’s responses for the note', leaks[0].url);
          throw new Error('The second person received the first person’s note.');
        }
      } finally {
        seen.stop();
      }
      at('Read the note as its owner');
      const owned = await app.data(ana.page, { table: 'notes', operation: 'list', where: { title: secret } });
      const note = Array.isArray(owned.data) ? owned.data[0] : undefined;
      if (!note) throw new Error('The owner’s request did not return the new note (HTTP ' + owned.status + ').');
      at('Check that the second person cannot read the note');
      await app.expectRefused(ben.page, { table: 'notes', operation: 'get', id: note.id }, { allowed: ana.page });
      at('Check that the second person cannot edit the note');
      await app.expectRefused(ben.page, { table: 'notes', operation: 'update', id: note.id, values: { title: 'changed' } }, { allowed: ana.page });
      at('Check that the second person cannot delete the note');
      await app.expectRefused(ben.page, { table: 'notes', operation: 'delete', id: note.id }, { allowed: ana.page });
    }, {
      requires: signedUp ? { name: roundTrip, passed: signedBackIn } : needsSignup,
      expected: 'Only the owner can read, edit, or delete the note.',
    });
` : `    // Your own tables (db/schema.ts), called as a signed-in person: app.data adds the release's
    // data contract and the Origin, and says ok, empty or refused. No need to read either from the page.
    //   const { data: [task] } = await app.data(ana.page, { table: 'tasks', operation: 'list' });
    //   await app.expectRefused(ben.page, { table: 'tasks', operation: 'get', id: task.id }, { allowed: ana.page });
`}    // A list item opens its page when a person clicks the item itself. Click the item element, not a link
    // inside it: a test that clicks the inner link passes even when clicking the item does nothing.
    //   await ana.page.getByTestId('team-item').first().click();
    //   await ana.page.getByTestId('team-name').waitFor();   // the item's own page, reached in the app
    await app.check('at phone width nothing scrolls sideways', async (at) => {
      at('Open the signed-in page at phone width', app.origin);
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
