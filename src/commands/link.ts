import { Command } from 'commander';
import { runInit } from './init.js';

/**
 * `somewhere link` — a discoverable top-level alias for `somewhere init --link`.
 * Agents look for `link`; it takes init's link options and runs init's own handler
 * with link set, so both commands accept the same flags and behave the same.
 */
export function registerLink(program: Command) {
  program
    .command('link')
    .description('Link this directory to an existing project (alias for `init --link`)')
    .option('--project <ref>', 'Existing project ID, name, slug, or subdomain')
    .option('--json', 'Print the linked project as JSON')
    .action((opts: { project?: string; json?: boolean }, command: Command) => runInit({ ...opts, link: true }, command));
}
