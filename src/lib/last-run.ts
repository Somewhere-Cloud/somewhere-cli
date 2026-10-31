import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { cliConfigDir } from './config.js';

/**
 * The local record of the last command (~/.somewhere/last-run.json, mode 600).
 *
 * Built from an allowlist by construction (pfb_04b5a285eed0): the registered
 * command path, the names of the options given on the command line, the exit
 * code and when it ran. Operand values, option values, request bodies and
 * command output are never recorded, so a secret passed as an argument (an env
 * value, SQL, a JSON payload) or printed by the command cannot reach the file.
 * Nothing in the CLI sends this file anywhere.
 */
export interface LocalRunRecord {
  command: string;
  options: string[];
  exit_code: number;
  timestamp: string;
  cli_version: string;
}

const RUN_RECORD_FILES = ['last-run.json', 'last-run.json.tmp'];

/**
 * Remove this CLI's run record before anything else runs (tsk_d8eac29404da).
 * CLI versions before 0.38.6 saved command arguments and output in it, so an
 * upgrade must not leave that file in place while a command runs. The file is
 * never read, copied or printed: only lstat'ed and unlinked. A symlink is
 * removed itself; its target is never followed or touched. Only these two
 * files in the configured config directory are touched (login and session
 * files are not). A file that cannot be removed is reported by path and error
 * code only. The exit writer then saves the metadata-only record.
 */
export function removeStaleRunRecord(dir: string = cliConfigDir()): void {
  for (const name of RUN_RECORD_FILES) {
    const path = join(dir, name);
    try {
      if (lstatSync(path).isDirectory()) {
        process.stderr.write(`Could not remove ${path}: it is a directory, not this CLI's run record. Check it yourself.\n`);
        continue;
      }
      unlinkSync(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      process.stderr.write(`Could not remove ${path} (${code ?? 'error'}). Older CLI versions may have saved command arguments and output there; delete it yourself.\n`);
    }
  }
}

/** The registered command path and the option names given on the command line. */
export function describeInvocation(action: Command): { command: string; options: string[] } {
  const names: string[] = [];
  for (let at: Command | null = action; at && at.parent; at = at.parent) names.unshift(at.name());
  const options = action.options
    .filter((option) => action.getOptionValueSource(option.attributeName()) === 'cli')
    .map((option) => option.long ?? option.short ?? '')
    .filter(Boolean)
    .sort();
  return { command: names.join(' '), options };
}

let invocation: { command: string; options: string[] } | null = null;

/** Called once the command is known (commander preAction). */
export function noteLastRunCommand(action: Command): void {
  invocation = describeInvocation(action);
}

/** Write the record when the process exits, without changing command output or failure behavior. */
export function recordLastRun(cliVersion: string): void {
  process.once('exit', (exitCode) => {
    try {
      const dir = cliConfigDir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const record: LocalRunRecord = {
        // A usage error never reaches a command: no command and no options.
        command: invocation?.command ?? '',
        options: invocation?.options ?? [],
        exit_code: exitCode ?? process.exitCode ?? 0,
        timestamp: new Date().toISOString(),
        cli_version: cliVersion,
      };
      const path = join(dir, 'last-run.json');
      const temporary = join(dir, 'last-run.json.tmp');
      writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
      renameSync(temporary, path);
    } catch {
      // Local diagnostics must never cause a CLI command to fail.
    }
  });
}
