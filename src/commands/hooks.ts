import { Command } from 'commander';
import { resolve } from 'node:path';
import { AGENT_HOSTS, formatAgentHookInstall, installAgentHooks, isAgentHost, type AgentHost } from '../lib/agent-hooks.js';
import { dim, error, info, printJson, success, warn } from '../lib/output.js';

export function registerHooks(program: Command) {
  const hooks = program
    .command('hooks')
    .description("Agent after-edit hooks: run the deploy's reference check after each file edit an agent makes");
  hooks
    .command('install [dir]')
    .description(
      "Add the after-edit check to this project's own agent settings (never user-wide settings). " +
        'Merges into existing settings without replacing other hooks. Edits made through shell commands are not checked; ' +
        'use `somewhere typecheck --deploy --watch` for those.',
    )
    .option('--host <host...>', `Agent hosts: ${AGENT_HOSTS.join(', ')}`, ['claude-code'])
    .option('--json', 'Print the installation result as JSON')
    .action((dirArg: string | undefined, opts: { host: string[]; json?: boolean }) => {
      const unknown = opts.host.filter((host) => !isAgentHost(host));
      if (unknown.length) {
        error(`Unknown host: ${unknown.join(', ')}. Use one of: ${AGENT_HOSTS.join(', ')}.`);
        process.exit(1);
      }
      const dir = resolve(process.cwd(), dirArg ?? '.');
      let results;
      try {
        results = installAgentHooks({ projectDir: dir, hosts: opts.host as AgentHost[] });
      } catch (failure) {
        error(failure instanceof Error ? failure.message : String(failure));
        process.exit(1);
      }
      if (opts.json) {
        printJson(results);
      } else {
        for (const [i, line] of formatAgentHookInstall(results, dir).entries()) {
          if (results[i].status === 'refused') warn(line);
          else success(line);
        }
        info(dim('Clean checks are silent; findings and checks that could not run are shown to the agent.'));
      }
      process.exit(results.some((r) => r.status === 'refused') ? 1 : 0);
    });
}
