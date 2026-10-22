import { Command } from 'commander';
import { join } from 'node:path';
import { ApiClient } from '../lib/client.js';
import { getToken, loadProjectConfig } from '../lib/config.js';
import { error, info, printJson, printJsonError, success, warn } from '../lib/output.js';
import { chooseProjectRef, projectRefConflictMessage } from '../lib/project-ref.js';
import { buildCrashRecord, buildPacket, readLastError, REPRO_SCHEMA, type ReproPacket } from '../lib/repro-packet.js';
import { writePrivateFile } from '../lib/test-identities.js';
import { CLI_VERSION } from '../lib/version.js';

/** Every registered command path ('db query', 'browser test', …), so a recorded command is kept only if it names one. */
function commandPaths(program: Command): Set<string> {
  const paths = new Set<string>();
  const walk = (command: Command, prefix: string[]) => {
    for (const child of command.commands) {
      const path = [...prefix, child.name()];
      paths.add(path.join(' '));
      walk(child, path);
    }
  };
  walk(program, []);
  return paths;
}

interface PacketOptions { json?: boolean; out?: string; trace?: string; project?: string }

export function registerSupport(program: Command): void {
  const support = program
    .command('support')
    .description('Platform-bug support: build a redacted repro packet for the last failed command');

  support
    .command('packet')
    .description('Build a redacted repro packet for the last failed command, or for one failed function request with --trace (local only; nothing is uploaded)')
    .option('--json', 'Print the packet as JSON')
    .option('--out <file>', 'Write the packet to a private file (0600) in the current folder')
    .option('--trace <id>', "Build it for one failed function request instead: the 32-character trace_id its error response returned (read from this project's own logs)")
    .option('--project <ref>', 'With --trace: the project the function belongs to (default: the linked folder)')
    .addHelpText('after', [
      '',
      'The packet holds only typed, validated fields: error code, HTTP status, an id-templated operation,',
      'request/trace/project ids, the platform\'s retry verdict, outcome and timing. It never holds the error',
      'message, stack, console, request or response bodies, arguments, SQL, URL queries, emails, headers,',
      'cookies, tokens, passwords, source or environment. Nothing is sent anywhere by this command.',
      'The error code is any UPPER_SNAKE word the platform or CLI returned; it is not checked against a list.',
      'With --trace, the request\'s log rows are read for their code, status, request id, method and route only.',
    ].join('\n'))
    .action(async (opts: PacketOptions) => {
      try {
        if (opts.trace !== undefined) { await tracePacket(opts); return; }
        if (opts.project !== undefined) throw new Error('--project goes with --trace.');
        const record = readLastError(commandPaths(program));
        if (!record) {
          if (opts.json) printJsonError('NO_FAILURE_RECORDED', 'No failed command is recorded on this machine yet.');
          else info('No failed command is recorded on this machine yet.');
          process.exitCode = 1;
          return;
        }
        emitPacket(buildPacket(record), opts);
      } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause), cause);
        process.exitCode = 1;
      }
    });
}

/** A failed function request the caller hit over HTTP: read that trace's rows from the owner's logs. */
async function tracePacket(opts: PacketOptions): Promise<void> {
  const traceId = String(opts.trace).trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(traceId)) throw new Error('--trace takes the 32-character trace_id from the failed response (or its X-Trace-Id header).');
  const chosen = chooseProjectRef(undefined, opts.project);
  if (chosen.kind === 'conflict') throw new Error(projectRefConflictMessage(chosen));
  const projectId = chosen.kind === 'ref' ? chosen.ref : loadProjectConfig()?.project_id;
  if (!projectId) throw new Error('No project. Pass --project <ref> or run from a linked directory.');
  const result = await new ApiClient(getToken()).call<{ logs?: unknown[] }>('GET', '/logs', undefined, { project_id: projectId, trace_id: traceId, limit: 50 });
  const record = buildCrashRecord(result.logs, { cliVersion: CLI_VERSION, traceId, projectId });
  if (!record) {
    const message = 'No failed function request is logged under that trace id in this project yet. Lines arrive within a few seconds; check the id and the project.';
    if (opts.json) printJsonError('NO_FAILURE_RECORDED', message);
    else info(message);
    process.exitCode = 1;
    return;
  }
  emitPacket(buildPacket(record), opts);
}

function emitPacket(packet: ReproPacket, opts: PacketOptions): void {
  if (opts.out) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(opts.out)) throw new Error('--out takes a plain file name in the current folder.');
    writePrivateFile(join(process.cwd(), opts.out), JSON.stringify(packet, null, 2) + '\n');
  }
  if (opts.json) { printJson(packet); return; }
  const c = packet.collected;
  info(`${REPRO_SCHEMA}  ${c.command ?? 'somewhere'}  ${c.code}${c.http_status ? ` (HTTP ${c.http_status})` : ''}  outcome: ${c.outcome}`);
  if (c.operation) info(`operation: ${c.operation}`);
  if (c.request_id || c.trace_id) info(`ids: ${[c.request_id && `request ${c.request_id}`, c.trace_id && `trace ${c.trace_id}`].filter(Boolean).join(' · ')}`);
  if (c.outcome === 'unknown') warn('The outcome is unknown: inspect before doing anything else; never retry it blindly.');
  info('Investigate:');
  for (const step of packet.recipe.investigate) info(`  ${step.join(' ')}`);
  info('Reproduce (synthetic, placeholders only):');
  for (const step of packet.recipe.steps) info(`  - ${step}`);
  info(`Not collected: ${packet.omitted.join(', ')}.`);
  if (opts.out) success(`Packet written to ${opts.out} (private). Review it before you submit it as a platform bug.`);
  else info('Nothing was sent. Review the packet (--json or --out <file>) before you submit it as a platform bug.');
}
