import { Command } from 'commander';
import ora from '../lib/spinner.js';
import prompts from 'prompts';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, platformErrorEnvelope, printJson, printJsonError, success, teal, warn } from '../lib/output.js';
import { chooseProjectRef, projectRefConflictMessage } from '../lib/project-ref.js';
import { unlinkedFolderHint } from '../lib/link-hint.js';
import { formatRollbackNotes, rememberActivation, rollbackErrorMessage, type RollbackResult } from './rollback.js';

/** `somewhere restore <version>`: make an earlier version live again through the
 *  platform's restore route (the one MCP project_restore_version calls). The
 *  version list is `somewhere status` / MCP project_deploys. */
export function registerRestore(program: Command) {
  program
    .command('restore <version>')
    .description(
      'Make an earlier deployed version live again, by number (e.g. `somewhere restore 3`). ' +
        'The platform puts that version\'s build back in production, with its functions; nothing is re-uploaded and this folder is not changed. ' +
        '`somewhere rollback` is the shortcut for the previous version. Afterwards `somewhere pull` brings this folder to the restored version.',
    )
    .option('--project <ref>', 'Project ID, name, slug, or subdomain (defaults to the linked project)')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--json', 'Print the raw restore response as JSON')
    .action(async (versionArg: string, opts) => {
      const fail = (code: string, message: string): never => {
        if (opts.json) printJsonError(code, message);
        else error(message);
        process.exit(1);
      };
      const version = Number(String(versionArg).replace(/^v/i, ''));
      if (!Number.isSafeInteger(version) || version < 1) fail('VALIDATION_ERROR', 'version must be a positive whole number, such as 3 or v3.');

      const chosen = chooseProjectRef(undefined, opts.project);
      if (chosen.kind === 'conflict') fail('PROJECT_REF_CONFLICT', projectRefConflictMessage(chosen));
      let projectId = chosen.kind === 'ref' ? chosen.ref : undefined;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) fail('NO_PROJECT', 'No project specified and no .somewhere.json found.' + unlinkedFolderHint());
        projectId = config!.project_id;
      }

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          fail('CONFIRMATION_REQUIRED', `Refusing to restore without confirmation in a non-interactive shell. Pass -y/--yes to restore intentionally (e.g. \`somewhere restore ${version} --yes\`).`);
        }
        const { ok } = await prompts({
          type: 'confirm', name: 'ok', initial: true,
          message: `Make v${version} of ${teal(projectId!)} live in production?`,
          stdout: opts.json ? process.stderr : undefined,
        });
        if (!ok) {
          if (opts.json) printJsonError('ABORTED', 'Aborted.');
          else warn('Aborted.');
          process.exit(1);
        }
      }

      const spinner = opts.json ? null : ora(`Restoring v${version}...`).start();
      try {
        const r = await new ApiClient(getToken()).call<RollbackResult>('POST', '/promote/restore', { project_id: projectId, version });
        spinner?.stop();
        rememberActivation('restore', projectId!, r);
        if (opts.json) {
          printJson(r);
          return;
        }
        success(`Restored v${r.version ?? version} to production.`);
        for (const line of formatRollbackNotes(r)) info(dim(line));
        info(dim('This folder is unchanged. `somewhere pull` brings it to the restored version.'));
      } catch (err) {
        spinner?.fail('Restore failed');
        const message = rollbackErrorMessage(err);
        if (opts.json) {
          if (err instanceof CliApiError) printJsonError(err.code, message, platformErrorEnvelope(err)?.extra);
          else printJsonError('CLI_ERROR', message);
          process.exit(1);
        }
        if (err instanceof CliApiError) error(`${message} ${dim(`[${err.code}${err.statusCode ? `, HTTP ${err.statusCode}` : ''}]`)}`);
        else error(message);
        process.exit(1);
      }
    });
}
