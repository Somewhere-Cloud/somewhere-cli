import { Command } from 'commander';
import { error, printJson } from '../lib/output.js';
import { callPlatformTool } from '../lib/platform-tools.js';
import { isRecord, resolveProjectRef, unwrapPlatformData } from '../lib/platform-command.js';

export function registerPrivacy(program: Command): void {
  program.command('privacy')
    .description('Read the active release privacy facts')
    .option('-p, --project <project>', 'Project slug or ID')
    .option('--json', 'Print the release record as JSON')
    .action(async (opts: { project?: string; json?: boolean }) => {
      try {
        const data = unwrapPlatformData(await callPlatformTool('project_privacy_facts', {
          project_id: resolveProjectRef(opts.project),
        }));
        if (opts.json) { printJson(data); return; }
        if (!isRecord(data) || !Array.isArray(data.privacy_lines) || !data.privacy_lines.every((line: unknown) => typeof line === 'string')) {
          throw new Error('Privacy facts unavailable for this release.');
        }
        console.log(data.privacy_lines.join('\n'));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err), err);
        process.exitCode = 1;
      }
    });
}
