import type { InitScaffoldFile } from './init-scaffold.js';

// The starter's journeys: small, independent specs an agent adapts instead of writing from nothing.
// Each one makes its own people (at the same time, with Promise.all), shares nothing with the others,
// runs alone or in any order, and waits on what the app does, never on a fixed sleep.

const FORM_ACCOUNT = `import { test, expect } from '@somewhere-cloud/cli/testing';

// A visitor signs up through the app's own form, signs out and signs back in.
test('sign up, sign out and sign back in', async ({ page, signUp, signOut, signIn }) => {
  const person = await signUp(page);
  await expect(page.getByText(person.email)).toBeVisible();
  await signOut(page);
  await signIn(page, person);
  await expect(page.getByText(person.email)).toBeVisible();
});
`;

// The minimal starter has no sign-in screens yet: these steps call its auth route from the page.
// Once the app has a form, drop the steps (starter form) or replace them with the form's own steps.
const ROUTE_ACCOUNT = `import { test, expect, type FormSteps } from '@somewhere-cloud/cli/testing';

// This app has no sign-in screens yet, so these steps use its auth route from the page.
// When you add a form, replace them with your form's steps: fill, submit.
const viaAuthRoute = (path: string): FormSteps => async (page, { email, password }) => {
  if (page.url() === 'about:blank') await page.goto('/');
  await page.evaluate(async ([path, body]) => {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await response.text(); // read the answer, as a form would
  }, [path, { email, password }] as const);
};
const signedInAs = async (page: import('@playwright/test').Page) => (await (await page.request.get('/api/auth/me')).json()).user;

test('sign up, sign out and sign back in', async ({ page, signUp, signOut, signIn }) => {
  const person = await signUp(page, { steps: viaAuthRoute('/api/auth/signup') });
  expect((await signedInAs(page)).email).toBe(person.email);
  await signOut(page, { steps: async page => { expect((await page.request.post('/api/auth/logout', { data: {} })).ok()).toBe(true); } });
  expect(await signedInAs(page)).toBeNull();
  await signIn(page, person, { steps: viaAuthRoute('/api/auth/login') });
  expect((await signedInAs(page)).email).toBe(person.email);
});
`;

const FORM_PHONE = (privateData: boolean) => `import { test, expect } from '@somewhere-cloud/cli/testing';

// One pass at phone width. Adapt: do the app's main action here, as a person on a phone would.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('phone: ${privateData ? 'sign up, add a note and sign out' : 'sign up and sign out'}', async ({ page, signUp, signOut }) => {
  const person = await signUp(page);
  await expect(page.getByText(person.email)).toBeVisible();
${privateData ? `  const title = 'phone ' + crypto.randomUUID();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
` : ''}  await signOut(page);
});
`;

const ROUTE_PHONE = `import { test, expect } from '@somewhere-cloud/cli/testing';

// One pass at phone width. Adapt: do the app's main action here, as a person on a phone would.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('phone: the page shows the greeting from its function', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Your full-stack app is ready.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
`;

// Two people, one role-holder: the access journeys. In the private-data starter the first one runs
// against its notes; elsewhere both say exactly what to fill in and are skipped until then.
const ACCESS = (variant: 'notes' | 'none' | 'minimal') => `import { test, expect, data, expectRefused } from '@somewhere-cloud/cli/testing';

// Adapt: a table whose rows belong to the person who made them, values to create one, and a change.
const OWNED = ${variant === 'notes'
  ? `{ table: 'notes', values: { title: 'private ' + crypto.randomUUID() }, change: { title: 'changed' } }`
  : `{ table: '', values: {} as Record<string, unknown>, change: {} as Record<string, unknown> }`};
// Adapt: a role from appRoles in db/schema.ts, a table only that role may use, and values to create a row.
const ROLE = { role: '', table: '', values: {} as Record<string, unknown> };

test('one person cannot see or change another person\\'s rows', async ({ newUser }) => {
  test.skip(!OWNED.table, 'Fill in OWNED at the top of tests/access.spec.ts');
  const [owner, other] = await Promise.all([newUser(), newUser()]);
${variant === 'notes' ? `  // The owner adds the row through the app's own form.
  await owner.page.goto('/');
  await owner.page.getByLabel('Title').fill(OWNED.values.title);
  await owner.page.getByRole('button', { name: 'Add note' }).click();
  await expect(owner.page.getByRole('heading', { name: OWNED.values.title })).toBeVisible();
  const listed = await data(owner.request, OWNED.table, { operation: 'list', where: { title: OWNED.values.title } });
  const { id } = (await listed.json()).data[0];
  // The other person's own list loads without it.
  await other.page.goto('/');
  await expect(other.page.getByText('No notes yet.')).toBeVisible();
` : `  const created = await data(owner.request, OWNED.table, { operation: 'create', values: OWNED.values });
  expect(created.status()).toBe(200);
  const { id } = (await created.json()).data;
`}  // Every way the other person could reach the row is refused; the owner is the positive control.
  await Promise.all([
    expectRefused(other, OWNED.table, { operation: 'get', id }, { allowed: owner }),
    expectRefused(other, OWNED.table, { operation: 'list', where: { id } }, { allowed: owner }),
    expectRefused(other, OWNED.table, { operation: 'update', id, values: OWNED.change }, { allowed: owner }),
    expectRefused(other, OWNED.table, { operation: 'delete', id }, { allowed: owner }),
  ]);
  // Nothing they tried changed it.
  const after = await data(owner.request, OWNED.table, { operation: 'get', id });
  expect((await after.json()).data).toMatchObject(OWNED.values);
});

test('a role-holder may use what a non-holder is refused', async ({ newUser }) => {
  test.skip(!ROLE.role, 'Fill in ROLE at the top of tests/access.spec.ts');
  const [holder, person] = await Promise.all([newUser({ role: ROLE.role }), newUser()]);
  const created = await data(holder.request, ROLE.table, { operation: 'create', values: ROLE.values });
  expect(created.status()).toBe(200);
  const { id } = (await created.json()).data;
  await Promise.all([
    expectRefused(person, ROLE.table, { operation: 'get', id }, { allowed: holder }),
    expectRefused(person, ROLE.table, { operation: 'create', values: ROLE.values }, { allowed: holder }),
    expectRefused(person, ROLE.table, { operation: 'delete', id }, { allowed: holder }),
  ]);
  expect((await (await data(holder.request, ROLE.table, { operation: 'get', id })).json()).data).toMatchObject(ROLE.values);
});
${variant === 'minimal' ? `
test('visitors cannot read the server-only greetings table', async ({ anonymous }) => {
  await expectRefused(anonymous, 'greetings', { operation: 'list' });
});
` : ''}`;

export function starterTests(options: { privateData?: boolean; minimal?: boolean } = {}): InitScaffoldFile[] {
  if (options.minimal) {
    return [
      { path: 'tests/account.spec.ts', content: ROUTE_ACCOUNT },
      { path: 'tests/phone.spec.ts', content: ROUTE_PHONE },
      { path: 'tests/access.spec.ts', content: ACCESS('minimal') },
    ];
  }
  return [
    { path: 'tests/account.spec.ts', content: FORM_ACCOUNT },
    { path: 'tests/phone.spec.ts', content: FORM_PHONE(Boolean(options.privateData)) },
    { path: 'tests/access.spec.ts', content: ACCESS(options.privateData ? 'notes' : 'none') },
  ];
}
