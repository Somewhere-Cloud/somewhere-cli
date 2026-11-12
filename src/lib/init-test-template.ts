import type { InitScaffoldFile } from './init-scaffold.js';

const example = `import { test } from 'node:test';
import { createUser, expectStatus, expectRefusal, UserSession } from '@somewhere-cloud/cli/testing';

// Run once: APP_URL=https://your-app.somewhere.site node --test tests/session.test.ts
// Rerun alone: add --test-name-pattern='independent user session' before the file.
test('independent user session', async () => {
  const url = process.env.APP_URL;
  if (!url) throw new Error('Set APP_URL to the deployed starter URL');
  const user = await createUser(url);
  const me = await user.request('/api/auth/me');
  await expectStatus(me, 200);
  const identity = await me.json() as { user: { id: string } | null };
  if (!identity.user?.id) throw new Error('Session cookie did not authenticate the user');
  // The default starter declares no browser data access. A malformed op probe
  // would be 400 and must fail this assertion, never pass as access denial.
  await expectRefusal(await new UserSession(url).data('notes', '', { operation: 'list' }), 403, 'DATA_ACCESS_DENIED');
  await expectStatus(await user.post('/api/auth/logout', {}), 200);
  const after = await user.request('/api/auth/me');
  await expectStatus(after, 200);
  if ((await after.json() as { user: unknown }).user !== null) throw new Error('Server did not confirm sign-out');
});
`;
export function starterTests(): InitScaffoldFile[] {
  return [{ path: 'tests/session.test.ts', content: example }];
}
