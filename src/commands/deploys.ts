import { Command } from 'commander';
import { ApiClient, CliApiError } from '../lib/client.js';
import { cliInvocation } from '../lib/cli-invocation.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { unlinkedFolderHint } from '../lib/link-hint.js';
import { error, formatUserSuppliedNote, printJson, printJsonError } from '../lib/output.js';
import { shellQuote } from '../lib/next-actions.js';

interface DeployHistory {
  deploys: Array<{
    version: number | null;
    status: string;
    promoted_at?: string;
    at?: string;
    message?: string;
    is_live: boolean;
    restore?: { body: { project_id: string; version: number } };
  }>;
}

function projectRef(explicit?: string): string {
  const project = explicit ?? loadProjectConfig()?.project_id;
  if (!project) throw new Error('Choose a project with --project.' + unlinkedFolderHint());
  return project;
}

function deployVersion(value: string): number {
  const version = Number(value.replace(/^v/i, ''));
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('Version must be a positive whole number, such as 3 or v3.');
  }
  return version;
}

function historyError(err: unknown, json?: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) printJsonError(err instanceof CliApiError ? err.code : 'CLI_ERROR', message);
  else error(message, err);
  process.exitCode = 1;
}

export function registerDeploys(program: Command): void {
  const deploys = program.command('deploys')
    .description('List recent deploys with their time, note and restore command.')
    .option('--project <ref>', 'Project ID or subdomain (defaults to the linked project)')
    .option('--json', 'Print deploy history as JSON')
    .action(async (options) => {
      try {
        const project = projectRef(options.project);
        const result = await new ApiClient(getToken()).call<DeployHistory>('GET', `/projects/${encodeURIComponent(project)}/deploys`);
        if (options.json) return printJson(result);
        if (result.deploys.length === 0) return console.log('No deploys yet.');
        for (const entry of result.deploys) {
          const version = entry.version === null ? '—' : `v${entry.version}`;
          const state = entry.is_live ? 'live' : entry.status;
          const note = entry.status === 'success' && entry.message ? formatUserSuppliedNote(entry.message) : '';
          const restore = entry.restore?.body;
          const command = restore ? `${cliInvocation()} restore ${restore.version} --project ${shellQuote(restore.project_id)} --yes` : '';
          console.log([version, entry.promoted_at ?? entry.at ?? '—', state, note, command].filter(Boolean).join('  '));
        }
      } catch (err) {
        historyError(err, options.json);
      }
    });

  deploys.command('note <version> <message>')
    .description('Set the note on an existing deploy (up to 200 characters).')
    .action(async (versionArg: string, message: string, _options: unknown, command: Command) => {
      const options = command.optsWithGlobals<{ project?: string; json?: boolean }>();
      try {
        const version = deployVersion(versionArg);
        const result = await new ApiClient(getToken()).call('PATCH', '/deploy/note', {
          project_id: projectRef(options.project), version, message,
        });
        if (options.json) return printJson(result);
        console.log(`Saved note for v${version}.`);
      } catch (err) {
        historyError(err, options.json);
      }
    });

  program.command('file <path>')
    .description('Print one deployed source file. Redirect stdout to save it.')
    .requiredOption('--version <number>', 'Retained production version to read (required)')
    .option('--project <ref>', 'Project ID or subdomain (defaults to the linked project)')
    .action(async (path: string, options) => {
      const project = projectRef(options.project);
      const version = deployVersion(options.version);
      const file = await new ApiClient(getToken()).call<{ content: string; encoding: 'utf-8' | 'base64' }>(
        'GET', '/deploy/file', undefined, { project_id: project, path, version },
      );
      process.stdout.write(Buffer.from(file.content, file.encoding));
    });
}
