import type { InitScaffoldFile } from './init-scaffold.js';

// One short, ordinary Playwright script an agent copies and changes, not a second test suite:
// nothing here is discovered by `somewhere test` (it runs tests/**/*.spec.ts only). The helpers come
// from @somewhere-cloud/cli/script and work the same from .mjs or .cjs.

const SCRIPT = (privateData: boolean) => `// tests/app-check.mjs — an ordinary Playwright script for this app: change the checks to match
// what you built. Run it after a successful deploy, never after a refused one:
//   npx somewhere deploy && node tests/app-check.mjs
// It writes its result once to .somewhere/app-check.json; the exit code is the verdict.
// From a .cjs script: const { openAppTest } = require('@somewhere-cloud/cli/script');
import { chromium } from '@playwright/test';
import { openAppTest${privateData ? ', captureResponses, dataReady' : ''} } from '@somewhere-cloud/cli/script';

const app = await openAppTest(); // stops if this folder has changes the live release lacks
const browser = await chromium.launch(app.launchOptions());
// One person = one browser context, signed up through the app's own form (accounts are
// deleted by exact id in finish()).
const person = async () => {
  const page = await browser.newPage({ baseURL: app.origin });
  return { page, account: await app.signUp(page) };
};
try {
  const [ana, ben] = await Promise.all([person(), person()]);
  await app.check('the signed-in page shows the account', () => ana.page.getByText(ana.account.email).waitFor());
  await app.check('sign out, then sign back in', async () => {
    await app.signOut(ana.page);
    await app.signIn(ana.page, ana.account);
  });
${privateData ? `  await app.check('a note stays private to its owner', async () => {
    const secret = 'private ' + crypto.randomUUID(); // a unique value: search for it, not a common word
    await ana.page.getByLabel('Title').fill(secret);
    await ana.page.getByRole('button', { name: 'Add note' }).click();
    await ana.page.getByRole('heading', { name: secret }).waitFor();
    const seen = captureResponses(ben.page);
    await ben.page.reload();
    await dataReady(ben.page); // the list has loaded, not merely "signed in"
    const leaks = await seen.find(secret);
    if (leaks.length) throw new Error('the other person received the note: ' + JSON.stringify(leaks));
    const { data: [note] } = await app.data(ana.page, { table: 'notes', operation: 'list', where: { title: secret } });
    await app.expectRefused(ben.page, { table: 'notes', operation: 'get', id: note.id }, { allowed: ana.page });
    await app.expectRefused(ben.page, { table: 'notes', operation: 'update', id: note.id, values: { title: 'changed' } }, { allowed: ana.page });
    await app.expectRefused(ben.page, { table: 'notes', operation: 'delete', id: note.id }, { allowed: ana.page });
  });
` : ''}  await app.check('at phone width nothing scrolls sideways', async () => {
    await ana.page.setViewportSize({ width: 390, height: 844 });
    await ana.page.reload();
    await ana.page.getByText(ana.account.email).waitFor();
    const wide = await ana.page.evaluate(() => [document.documentElement, ...document.querySelectorAll('body *')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1
        && (el === document.documentElement || ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)))
      .map((el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '')));
    if (wide.length) throw new Error('scrolls sideways at 390 px: ' + wide.join(', '));
  });
} finally {
  await app.finish(); // confirms the release, deletes the accounts, writes the result once
  await browser.close();
}
`;

/** The starter's example script (auth starters only; the minimal starter has no sign-in form). */
export function starterTests(options: { privateData?: boolean } = {}): InitScaffoldFile[] {
  return [{ path: 'tests/app-check.mjs', content: SCRIPT(Boolean(options.privateData)) }];
}
