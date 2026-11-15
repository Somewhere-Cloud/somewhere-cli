// What a test run prints at the end, the same for a script run on its own (openAppTest's finish()) and for
// `somewhere test`: failures first, one line each; then passes and checks that did not run, one line each; one
// summary line; what to do next; and, only after a failure or with --verbose, the full result file, relative to the
// project. No release ids and no absolute paths on the result lines.

/** The one way the docs, the starter's test file and this output write the commands: works in a fresh project
 *  with no global install (the starter pins @somewhere-cloud/cli). */
export const DEPLOY_COMMAND = 'npx @somewhere-cloud/cli deploy';
export const TEST_COMMAND = 'npx @somewhere-cloud/cli test';

export interface ReportCheck { name: string; ok: boolean; skipped?: 'after-failure' | 'passed-last-run'; error?: string }
export interface ReportGroup { script: string; checks: ReportCheck[]; resultFile: string | null }

const firstLine = (text: string | undefined) => (text ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function describeReport(groups: ReportGroup[], options: { verbose?: boolean } = {}): string[] {
  const many = groups.length > 1;
  const checks = groups.flatMap((group) => group.checks.map((check) => ({ ...check, script: many && check.name !== group.script ? group.script : null })));
  // One bracket per line: the script (when several ran) and any note together.
  const note = (script: string | null, extra?: string) => { const parts = [script, extra].filter(Boolean); return parts.length ? ` (${parts.join(', ')})` : ''; };
  const failed = checks.filter((check) => !check.ok && !check.skipped);
  const notRun = checks.filter((check) => check.skipped === 'after-failure');
  const lines = [
    ...failed.map((check) => `FAIL ${check.name}${note(check.script)}: ${firstLine(check.error) || 'failed'}`),
    ...checks.filter((check) => check.ok).map((check) => `PASS ${check.name}${note(check.script, check.skipped === 'passed-last-run' ? 'passed last run, not rerun' : undefined)}`),
    ...notRun.map((check) => `NOT RUN ${check.name}${note(check.script, 'after the first failure')}`),
  ];
  const scripts = plural(groups.length, 'script');
  if (!checks.length) lines.push(`FAILED: no check ran in ${scripts}: it stopped before its first check (its error is in the script's output).`);
  else if (failed.length) lines.push(`FAILED: ${failed.length} of ${plural(checks.length, 'check')} in ${scripts}${notRun.length ? ` (${notRun.length} not run)` : ''}`);
  else lines.push(`PASSED: ${plural(checks.length, 'check')} in ${scripts}`);
  if (!checks.length) lines.push(`Next: fix the error in the script's output, then run ${TEST_COMMAND} again.`);
  else if (failed.length) lines.push(`Next: fix what each FAIL line names, run ${DEPLOY_COMMAND}, then ${TEST_COMMAND} --failed to rerun only what failed.`);
  const files = [...new Set(groups.map((group) => group.resultFile).filter((file): file is string => Boolean(file)))];
  if (files.length && (failed.length || !checks.length || options.verbose)) lines.push(`Full result: ${files.join(', ')}`);
  return lines;
}
