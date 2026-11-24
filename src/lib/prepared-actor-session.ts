import { createHash } from 'node:crypto';
import { closeSync, openSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { UserSession } from './test-session.js';
import { ACCESS_COOKIE, preparedActorState, testAccessNeedsRefresh, writePrivateFile } from './test-identities.js';
import type { TestTarget } from './test-target.js';

export async function preparedActorSession(root: string, target: TestTarget, name: string): Promise<string> {
  const read = () => preparedActorState(root, target, name);
  const initial = read();
  if (!testAccessNeedsRefresh(initial.access)) return initial.access;

  // Only one CLI process may rotate this file's refresh credential at a time.
  const generation = createHash('sha256').update(initial.access).digest('hex').slice(0, 12);
  const lock = initial.path + '.' + generation + '.refresh.lock';
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const latest = read();
      if (!testAccessNeedsRefresh(latest.access)) return latest.access;
      await delay(100);
      continue;
    }
    try {
      const latest = read();
      if (!testAccessNeedsRefresh(latest.access)) return latest.access;
      const session = new UserSession(target.origin, { target, storageState: latest.state });
      const renewed = await session.storageState();
      const token = renewed.cookies.find(cookie => cookie.name === ACCESS_COOKIE)?.value;
      if (!token || testAccessNeedsRefresh(token)) throw new Error('The saved test session could not be renewed.');
      writePrivateFile(latest.path, JSON.stringify(renewed, null, 2) + '\n');
      return token;
    } finally {
      closeSync(fd);
      rmSync(lock, { force: true });
    }
  }
  throw new Error(`Another command is refreshing test user ${name}. Wait for it to finish, or clean up and prepare the test users again.`);
}
