import type { InitScaffoldFile } from './init-scaffold.js';

// The starter's saved check: checks/<plain-name>.json ships with the source, and the platform runs it in its own
// browser after every deploy (`somewhere test` runs it now). The format is the `somewhere verify --flow` actions
// list, plus "signed_in" and "viewports". Only the private-data starter has a notes form to check.

const ADD_A_NOTE = {
  actions: [
    { fill: '[data-testid=note-title]', value: 'Lunch with Ana 42' },
    { click: '[data-testid=note-save]' },
    { expect: { selector: '[data-testid=note-item]', text: 'Lunch with Ana 42' } },
  ],
  viewports: ['desktop', 'mobile'],
  signed_in: true,
};

export function starterChecks(options: { privateData?: boolean } = {}): InitScaffoldFile[] {
  return options.privateData ? [{ path: 'checks/add-a-note.json', content: JSON.stringify(ADD_A_NOTE, null, 2) + '\n' }] : [];
}

// The starter's check list: checks/<plain-name>.json with "users" and "steps". `somewhere test` runs it on the live app
// as test users the platform makes for the run, and it reruns after every deploy. Agents extend it with their own steps.
export const STARTER_CHECK_LIST: InitScaffoldFile = {
  path: 'checks/signed-in.json',
  content: `{
  "users": ["ana"],
  "steps": [
    { "as": "ana", "get": "/api/auth/me", "has": "{ana.email}" },
    { "as": "signed_out", "get": "/api/auth/me", "lacks": "{ana.email}" }
  ]
}
`,
};

export const STARTER_AUTH_TEST: InitScaffoldFile = {
  path: 'tests/starter.mjs',
  content: `import assert from 'node:assert/strict';
import { openTestApp } from '@somewhere-cloud/cli/testing';

const app = await openTestApp();
try {
  const [person] = await app.users(1);
  const response = await person.session.request('/api/auth/me');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.id, person.id);
  console.log('The deployed app recognizes the test user.');
} finally {
  await app.cleanup();
}
`,
};
