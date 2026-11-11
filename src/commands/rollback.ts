import { Command } from 'commander';
import ora from '../lib/spinner.js';
import prompts from 'prompts';
import { ApiClient, CliApiError } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { dim, error, info, platformErrorEnvelope, printJson, printJsonError, success, teal, warn } from '../lib/output.js';
import { chooseProjectRef, projectRefConflictMessage } from '../lib/project-ref.js';
import { unlinkedFolderHint } from '../lib/link-hint.js';
import { saveLastActivation } from '../lib/base-files.js';

/** Remember in the linked folder that it put this release live itself, so a
 *  later refused deploy names this folder's own rollback/restore (tsk_0dcd7530). */
export function rememberActivation(kind: 'rollback' | 'restore', projectId: string, result: Pick<RollbackResult, 'active_release_id' | 'version'>): void {
  const config = loadProjectConfig();
  if (!config || !result.active_release_id) return;
  if (config.project_id !== projectId && config.subdomain !== projectId && config.name !== projectId) return;
  saveLastActivation(process.cwd(), {
    project_id: config.project_id, kind, release_id: result.active_release_id,
    version: typeof result.version === 'number' ? result.version : null, at: new Date().toISOString(),
  });
}

export interface RollbackResult {
  restored_at: string;
  version: number;
  /** The release now live, and the one it replaced (platform 2026-11-11+). */
  active_release_id?: string;
  from_release_id?: string | null;
  files_restored?: number | null;
  message?: string | null;
  /** Tables and columns added since the target stay, with their data (null when none). */
  database_notice?: string | null;
}

/** The "Version notes" lines: the platform's message, then its database
 *  notice unless the message already says it word for word. */
export function formatRollbackNotes(result: Pick<RollbackResult, 'message' | 'database_notice'>): string[] {
  const message = typeof result.message === 'string' ? result.message.trim() : '';
  const notice = typeof result.database_notice === 'string' ? result.database_notice.trim() : '';
  return [
    ...(message ? [`Version notes: ${message}`] : []),
    ...(notice && !message.includes(notice) ? [`Version notes: ${notice}`] : []),
  ];
}

export function formatRollbackSuccess(
  result: Pick<RollbackResult, 'version' | 'files_restored'>,
): string {
  const version = typeof result.version === 'number' && Number.isFinite(result.version)
    ? ` to v${result.version}`
    : '';
  const restored = typeof result.files_restored === 'number' && Number.isFinite(result.files_restored)
    ? ` (${result.files_restored} file${result.files_restored === 1 ? '' : 's'} restored)`
    : '';
  return `Rolled back${version}${restored}`;
}

export function registerRollback(program: Command) {
  program
    .command('rollback [project]')
    .description(
      'Revert production to the previous deployed version (for any earlier version: `somewhere restore <version>`). Use this when a ' +
        'promote shipped a bad build — it restores the version that was live ' +
        'before, including its functions. (Requires a previous production ' +
        'version to return to.)',
    )
    .option('--project <ref>', 'Project ID, name, slug, or subdomain — the same flag every other command takes. The positional form still works.')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--json', 'Print the raw rollback response as JSON')
    .action(async (projectArg: string | undefined, opts) => {
      const client = new ApiClient(getToken());

      const chosen = chooseProjectRef(projectArg, opts.project);
      if (chosen.kind === 'conflict') {
        const conflictMessage = projectRefConflictMessage(chosen);
        if (opts.json) printJsonError('PROJECT_REF_CONFLICT', conflictMessage);
        else error(conflictMessage);
        process.exit(1);
      }
      let projectId = chosen.kind === 'ref' ? chosen.ref : undefined;
      if (!projectId) {
        const config = loadProjectConfig();
        if (!config) {
          if (opts.json) {
            printJsonError('NO_PROJECT', 'No project specified and no .somewhere.json found.' + unlinkedFolderHint());
            process.exit(1);
          }
          error('No project specified and no .somewhere.json found.' + unlinkedFolderHint());
          process.exit(1);
        }
        projectId = config.project_id;
      }

      if (!opts.yes) {
        // Fail fast in a non-interactive shell instead of blocking forever on a
        // prompt no one can answer (A-F07): an inherited pipe never delivers a
        // keystroke, so `prompts` hangs. Match deploy's --force guard — exit
        // with actionable -y/--yes guidance rather than a mute wedge.
        if (!process.stdin.isTTY) {
          const message =
            'Refusing to roll back without confirmation in a non-interactive shell. Pass -y/--yes to roll back intentionally (e.g. `somewhere rollback --yes`).';
          if (opts.json) {
            printJsonError('CONFIRMATION_REQUIRED', message);
          } else {
            error(message);
          }
          process.exit(1);
        }
        const { ok } = await prompts({
          type: 'confirm',
          name: 'ok',
          message: `Roll ${teal(projectId)} production back to the previous version?`,
          initial: true,
          stdout: opts.json ? process.stderr : undefined,
        });
        if (!ok) {
          // Non-zero so a script/agent can't mistake an abort (incl. a non-TTY
          // prompt that auto-declines) for a completed rollback.
          if (opts.json) {
            printJsonError('ABORTED', 'Aborted.');
            process.exit(1);
          }
          warn('Aborted.');
          process.exit(1);
        }
      }

      const spinner = opts.json ? null : ora('Rolling back...').start();
      try {
        const r = await client.call<RollbackResult>('POST', '/promote/rollback', {
          project_id: projectId,
        });
        spinner?.stop();
        rememberActivation('rollback', projectId, r);
        if (opts.json) {
          printJson(r);
          return;
        }
        success(formatRollbackSuccess(r));
        info(dim('This folder still holds the newer source. `somewhere pull` brings it to the version now live; deploying it unchanged is refused until then.'));
        for (const line of formatRollbackNotes(r)) info(dim(line));
      } catch (err) {
        spinner?.fail('Rollback failed');
        const message = rollbackErrorMessage(err);
        if (opts.json) {
          if (err instanceof CliApiError) {
            printJsonError(err.code, message, platformErrorEnvelope(err)?.extra);
          } else {
            printJsonError('CLI_ERROR', message);
          }
          process.exit(1);
        }
        if (err instanceof CliApiError) {
          error(`${message} ${dim(`[${err.code}${err.statusCode ? `, HTTP ${err.statusCode}` : ''}]`)}`);
        } else {
          error(message);
        }
        process.exit(1);
      }
    });
}

export function rollbackErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof CliApiError && /no restorable snapshot/i.test(message)) {
    return 'Rollback is unavailable because the platform could not find a restorable previous production release. No changes were made. Redeploy the source you want in production, or try another recorded release.';
  }
  return message;
}
