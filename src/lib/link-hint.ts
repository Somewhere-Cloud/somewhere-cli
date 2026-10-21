import { loadConfig } from './config.js';

/** Appended wherever a command needs a project and this folder has no link
 *  (tsk_8a68dfa2 item 15): name the exact commands that link one, instead of
 *  assuming the reader knows what "a linked directory" is. Wording only; it
 *  never links, creates or signs in on its own. */
export function unlinkedFolderHint(): string {
  const config = loadConfig();
  const signedIn = Boolean(config?.token) && config?.temporary !== true;
  return signedIn
    ? ' Link this folder to a project: `somewhere init --link --project <name-or-id>` (list yours with `somewhere projects`), or create one: `somewhere init --bare --name <name>`.'
    : ' Sign in first (`somewhere login`), then link this folder: `somewhere init --link --project <name-or-id>`.';
}
