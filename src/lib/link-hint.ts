import { cliInvocation } from './cli-invocation.js';
import { loadConfig } from './config.js';

/** Appended wherever a command needs a project and this folder has no link
 *  ( item 15): name the exact commands that link one, instead of
 *  assuming the reader knows what "a linked directory" is. Wording only; it
 *  never links, creates or signs in on its own. */
export function unlinkedFolderHint(): string {
  const config = loadConfig();
  const signedIn = Boolean(config?.token) && config?.temporary !== true;
  return signedIn
    ? ` Link this folder to a project: \`${cliInvocation()} init --link --project <name-or-id>\` (list yours with \`${cliInvocation()} projects\`), or create one: \`${cliInvocation()} init --bare --name <name>\`.`
    : ` Sign in first (\`${cliInvocation()} login\`), then link this folder: \`${cliInvocation()} init --link --project <name-or-id>\`.`;
}
