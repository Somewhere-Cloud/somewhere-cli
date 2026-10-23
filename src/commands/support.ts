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

interface PacketOptions { json?: boolean; out?: string; trace?: string; project?: string; request?: string }

export function registerSupport(program: Command): void {
  const support = program
    .command('support')
    .description('Platform-bug support: build a redacted repro packet for the last failed command');

  support
    .command('packet')
    .description('Build a redacted repro packet for the last failed command, or for one failed function request with --trace (local only; nothing is uploaded)')
    .option('--json', 'Print the packet as JSON')
    .option('--request <id>', 'Require this exact server request id in the locally recorded failure; refuse if replaced or unavailable')
    .option('--out <file>', 'Write the packet to a private file (0600) in the current folder')
    .option('--trace <id>', "Build it for one failed function request instead: the 32-character trace_id its error response returned (read from this project's own logs)")
    .option('--project <ref>', 'With --trace: the project the function belongs to (default: the linked folder)')
    .addHelpText('after', [
      '',
      'The packet is built only from these fields, each checked against a fixed shape: error code, HTTP',
      'status, an operation (method plus route, every path segment replaced by :id or :seg), request/trace/',
      'project ids, the platform\'s retry verdict, outcome and timing. It does not read the error message,',
      'stack, console output, request or response bodies, arguments, SQL, URL queries, headers or cookies.',
      'Error code: with --trace it is kept only if it is one of the function runtime\'s own failure codes',
      '(an app\'s own error code becomes APP_ERROR_CODE); for a failed CLI command it is the code the',
      'platform API answered. Review the packet before you submit it. Nothing is sent anywhere by this command.',
    ].join('\n'))
    .action(async (opts: PacketOptions) => {
      try {
        if (opts.request !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(opts.request) || opts.trace !== undefined)) {
          printJsonError('INVALID_REQUEST_SELECTOR', '--request takes a server request id and cannot be combined with --trace.');
          process.exitCode = 1; return;
        }
        if (opts.trace !== undefined) { await tracePacket(opts); return; }
        if (opts.project !== undefined) throw new Error('--project goes with --trace.');
        const record = readLastError(commandPaths(program));
        if (opts.request !== undefined && (!record || record.request_id !== opts.request)) {
          printJsonError(record ? 'REQUEST_FAILURE_MISMATCH' : 'REQUEST_FAILURE_UNAVAILABLE', 'The requested failure is not the locally recorded snapshot. No packet was produced.');
          process.exitCode = 1; return;
        }
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
  else if (c.request_id && !opts.trace) info(`Nothing was sent. Review this request's packet with somewhere support packet --request ${c.request_id} --json (or --out <file>); it refuses if the local record has changed.`);
  else if (opts.trace) info('Nothing was sent. Review this trace packet before you submit it as a platform bug.');
  else info('Nothing was sent. Review the packet before submitting it. Without --request, the local record is the most recent failure in this config, not pinned to an invocation.');
}
