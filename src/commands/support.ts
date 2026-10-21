import { Command } from 'commander';
import { join } from 'node:path';
import { error, info, printJson, printJsonError, success, warn } from '../lib/output.js';
import { buildPacket, readLastError, REPRO_SCHEMA } from '../lib/repro-packet.js';
import { writePrivateFile } from '../lib/test-identities.js';

export function registerSupport(program: Command): void {
  const support = program
    .command('support')
    .description('Platform-bug support: build a redacted repro packet for the last failed command');

  support
    .command('packet')
    .description('Build a redacted repro packet for the last failed command (local only; nothing is uploaded)')
    .option('--json', 'Print the packet as JSON')
    .option('--out <file>', 'Write the packet to a private file (0600) in the current folder')
    .addHelpText('after', [
      '',
      'The packet holds only typed, validated fields: error code, HTTP status, an id-templated operation,',
      'request/trace/project ids, the platform\'s retry verdict, outcome and timing. It never holds the error',
      'message, stack, console, request or response bodies, arguments, SQL, URL queries, emails, headers,',
      'cookies, tokens, passwords, source or environment. Nothing is sent anywhere by this command.',
    ].join('\n'))
    .action((opts: { json?: boolean; out?: string }) => {
      try {
        const record = readLastError();
        if (!record) {
          if (opts.json) printJsonError('NO_FAILURE_RECORDED', 'No failed command is recorded on this machine yet.');
          else info('No failed command is recorded on this machine yet.');
          process.exitCode = 1;
          return;
        }
        const packet = buildPacket(record);
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
      } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause), cause);
        process.exitCode = 1;
      }
    });
}
