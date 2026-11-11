import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { registerAuth } from './commands/auth.js';
import { registerInit } from './commands/init.js';
import { registerLink } from './commands/link.js';
import { registerProject } from './commands/project.js';
import { registerDeploy } from './commands/deploy.js';
import { registerPull } from './commands/pull.js';
import { registerLint } from './commands/lint.js';
import { registerTypecheck } from './commands/typecheck.js';
import { registerHooks } from './commands/hooks.js';
import { registerPromote } from './commands/promote.js';
import { registerRollback } from './commands/rollback.js';
import { registerRestore } from './commands/restore.js';
import { registerDb } from './commands/db.js';
import { registerPostgres } from './commands/postgres.js';
import { registerDocs } from './commands/docs.js';
import { registerAdvisor } from './commands/advisor.js';
import { registerCatalog } from './commands/catalog.js';
import { registerLogs } from './commands/logs.js';
import { registerErrors } from './commands/errors.js';
import { registerEnv } from './commands/env.js';
import { registerRun } from './commands/run.js';
import { registerStatus } from './commands/status.js';
import { registerOpen } from './commands/open.js';
import { registerClaim } from './commands/claim.js';
import { registerDev, registerPreview } from './commands/dev.js';
import { registerBrowser } from './commands/browser.js';
import { registerVerify } from './commands/verify.js';
import { registerCheck } from './commands/check.js';
import { registerApi } from './commands/api.js';
import { registerFs } from './commands/fs.js';
import { registerMcp } from './commands/mcp.js';
import { registerUpdate } from './commands/update.js';
import { registerUpgrade } from './commands/upgrade.js';
import { registerCall } from './commands/call.js';
import { registerTasks } from './commands/tasks.js';
import { registerFeedback } from './commands/feedback.js';
import { registerGrep } from './commands/grep.js';
import { registerUsage } from './commands/usage.js';
import { registerGit } from './commands/git.js';
import { registerCron } from './commands/cron.js';
import { registerEmail } from './commands/email.js';
import { registerTestUsers } from './commands/test-users.js';
import { registerSupport } from './commands/support.js';
import { buildRecord, commandPath, writeLastError } from './lib/repro-packet.js';
import { registerSkills } from './commands/skills.js';
import { registerAi } from './commands/ai.js';
import { collectNotices } from './lib/notify/index.js';
import { startupNotice } from './lib/startup-notice.js';
import { error, info, printJsonError, setFailureHook, setJsonOutputMode, stripAnsi } from './lib/output.js';
import { loadProjectConfig } from './lib/config.js';
import { noteLastRunCommand, recordLastRun, removeStaleRunRecord } from './lib/last-run.js';
import { recoverClaimHandoff } from './lib/claim-handoff.js';
import { helpSummary } from './lib/help-summary.js';
import { decidePin, PINNED_CHILD_ENV } from './lib/project-pin.js';
import { CLI_VERSION } from './lib/version.js';

// A project pinned to another CLI version says so in one line, and a pinned
// version installed in its node_modules runs the command (tsk_a4641877).
const pinned = decidePin(process.cwd(), CLI_VERSION, process.argv, process.env);
if (pinned.notice) process.stderr.write(pinned.notice + '\n');
if (pinned.delegate) {
  const child = spawnSync(process.execPath, [pinned.delegate, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [PINNED_CHILD_ENV]: '1' },
  });
  if (child.error) throw child.error;
  if (child.signal) process.kill(process.pid, child.signal);
  process.exit(child.status ?? 1);
}

// First, before any command, help, version or usage error can run: remove a run
// record an older CLI may have filled with argument values (tsk_d8eac29404da).
removeStaleRunRecord();

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { version: string };

const program = new Command()
  .name('somewhere')
  .description('CLI for somewhere.cloud')
  .version(pkg.version);

recordLastRun(pkg.version);
const jsonOutputRequested = process.argv.includes('--json');
setJsonOutputMode(jsonOutputRequested);

// Local repro capture (tsk_da2dba3d): typed fields of the failure plus registered command names
// only. The support group's own failures never replace the record it reports on.
const startedAt = Date.now();
let commandNames: string[] = [];
program.hook('preAction', (_self, action) => {
  noteLastRunCommand(action);
  const names: string[] = [];
  for (let at: Command | null = action; at && at.parent; at = at.parent) names.unshift(at.name());
  commandNames = names;
});
setFailureHook((cause) => {
  const command = commandPath(commandNames);
  if (command?.split(' ')[0] === 'support') return;
  writeLastError(buildRecord(cause, { cliVersion: pkg.version, command, projectId: loadProjectConfig()?.project_id, startedAt }));
});

// First output of every interactive command — see lib/startup-notice.ts.
const notice = startupNotice(pkg.version, {
  isTTY: Boolean(process.stdout.isTTY),
  jsonOutput: jsonOutputRequested,
  passThrough: false,
});
if (notice) process.stderr.write(notice + '\n');
if (jsonOutputRequested) {
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
}

registerAuth(program);
registerInit(program);
registerLink(program);
registerProject(program);
registerDeploy(program);
registerPull(program);
registerTypecheck(program);
registerLint(program);
registerHooks(program);
registerPromote(program);
registerRollback(program);
registerRestore(program);
registerDb(program);
registerPostgres(program);
registerDocs(program);
registerAdvisor(program);
registerCatalog(program);
registerLogs(program);
registerErrors(program);
registerEnv(program);
registerRun(program);
registerStatus(program);
registerOpen(program);
registerClaim(program);
registerDev(program);
registerPreview(program);
registerBrowser(program);
registerVerify(program);
registerTestUsers(program);
registerSupport(program);
registerCheck(program);
registerApi(program);
registerFs(program);
registerMcp(program);
registerUpdate(program);
registerUpgrade(program);
registerCall(program);
registerTasks(program);
registerFeedback(program);
registerGrep(program);
registerUsage(program);
registerGit(program);
registerCron(program);
registerEmail(program);
registerSkills(program);
registerAi(program);

// Configure only the root after registration: command help keeps its full contract.
program.configureHelp({
  subcommandDescription: (command) => command.summary() || helpSummary(command.description()),
});
program.addHelpText('after', '\nRun somewhere <command> --help for full command details.');

// User-notification pipeline (update-available, advisories, announcements…).
// Centrally gated to interactive, non-CI, non-pass-through commands and emitted to
// STDERR as a parting line AFTER the command, never stdout or agent output.
// Fail-open: collectNotices swallows all errors.
//
// Do NOT await this before parsing — the once-a-day cache-refresh fetch would add
// startup latency to every command. Kick it off, parse immediately; if it resolves
// before the process exits (the common cache-hit path is instant) it prints on
// exit, otherwise it silently lags to the next invocation.
// A reader that closed stdout early (`somewhere docs | head -1`) is a local
// closed pipe, not a failure of the command: stop quietly, as Unix tools do.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});
collectNotices(process.argv)
  .then((notices) => {
    if (notices.length) process.on('exit', () => process.stderr.write('\n' + notices.join('\n') + '\n'));
  })
  .catch(() => {});
try {
  const command = process.argv[2] || '';
  // Help, version and update never wait on, or fail because of, an API call (tsk_224b77a0).
  const skipRecovery = ['lint', 'upgrade', 'update', 'login', 'signup', 'logout', 'docs', 'help', '--help', '-h', '--version', '-V'].includes(command);
  const recovery = skipRecovery ? { kind: 'none' as const } : await recoverClaimHandoff();
  if (recovery.kind === 'recovered' && recovery.message && !jsonOutputRequested) info(recovery.message);
  if (recovery.kind === 'stale' && recovery.message) {
    if (jsonOutputRequested) console.error(recovery.message);
    else info(recovery.message);
  }
  if (recovery.kind === 'manual' && recovery.message && !['login', 'signup', 'logout', 'docs'].includes(command)) {
    throw new Error(recovery.message);
  }
  await program.parseAsync();
} catch (err) {
  if (jsonOutputRequested && err instanceof CommanderError) {
    if (err.code !== 'commander.helpDisplayed' && err.code !== 'commander.version') {
      printJsonError('USAGE_ERROR', stripAnsi(err.message.replace(/^error:\s*/i, '')));
      process.exitCode = err.exitCode || 1;
    }
  } else if (err instanceof Error) {
    error(err.message, err);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
