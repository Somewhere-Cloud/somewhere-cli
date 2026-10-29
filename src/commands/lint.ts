import { Command } from 'commander';
import { resolve } from 'node:path';
import { lintProject } from '../lib/source-lint.js';
import { printJson } from '../lib/output.js';

export function registerLint(program: Command): void {
  program.command('lint [dir]')
    .description('Check Somewhere source contracts offline before deploy: credentials in source, schema declarations, directory index routes, request input choosing row ownership on server writes, sw.email.send awaited inside a loop, and a user directory scanned for one email. Reports warnings with rule, file, line, fix and docs. Does not install packages or change files; authorization and general type correctness are not proved.')
    .option('--generic', 'Also run the project’s installed Oxlint; no downloads or type-aware checking')
    .option('--json', 'Print structured findings and source/schema fingerprints')
    .action(async (dir: string | undefined, opts: { json?: boolean; generic?: boolean }) => {
      const result = await lintProject(resolve(process.cwd(), dir ?? '.'), opts);
      if (opts.json) printJson(result);
      else {
        for (const finding of [...result.findings, ...result.generic.findings]) {
          console.log(`${finding.file}:${finding.line} warning ${finding.rule}: ${finding.message}\n  Fix: ${finding.fix}\n  ${finding.docs}`);
        }
        for (const skipped of result.skipped) console.log(`Not checked: ${skipped.path} — ${skipped.reason}`);
        console.log(`${result.findings.length + result.generic.findings.length} warning(s); ${result.checked_files} source files; ${result.duration_ms.toFixed(1)} ms.`);
        if (result.generic.reason) console.log(result.generic.reason);
        console.log('Authorization is not assessed. Type checking is separate; generic rules run only with --generic.');
      }
      // Findings are advisory. An incomplete file read is a failed check, not a
      // clean result. Existing deploy guards retain their own refusal behavior.
      process.exitCode = result.ok ? 0 : 2;
    });
}
