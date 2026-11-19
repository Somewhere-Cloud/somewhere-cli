// What a test run prints at the end, the same for a script run on its own (openAppTest's finish()) and for
// `somewhere test`: failures with their evidence first, then short passes and skips, one
// summary line; what to do next; and, only after a failure or with --verbose, the full result file, relative to the
// project. No release ids and no absolute paths on the result lines.

/** The one way the docs, the starter's test file and this output write the commands: works in a fresh project
 *  with no global install (the starter pins @somewhere-cloud/cli). */
export const DEPLOY_COMMAND = 'npx @somewhere-cloud/cli deploy';
export const TEST_COMMAND = 'npx @somewhere-cloud/cli test';

export interface CheckFailure { expected: string; happened: string; step: string; evidence?: string }
export interface ReportCheck {
  name: string;
  ok: boolean;
  skipped?: 'after-failure' | 'prerequisite';
  error?: string;
  failure?: CheckFailure;
}
export interface ReportGroup { script: string; checks: ReportCheck[]; resultFile: string | null }

const firstLine = (text: string | undefined) => (text ?? '').split('\n').map((line) => line.trim())
  .find((line) => line && !/^(?:hint:|Usage details:|Platform bug reports:)/i.test(line)) ?? '';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function describeReport(groups: ReportGroup[], options: { verbose?: boolean } = {}): string[] {
  const many = groups.length > 1;
  const checks = groups.flatMap((group) => group.checks.map((check) => ({ ...check, script: many && check.name !== group.script ? group.script : null })));
  // One bracket per line: the script (when several ran) and any note together.
  const note = (script: string | null, extra?: string) => { const parts = [script, extra].filter(Boolean); return parts.length ? ` (${parts.join(', ')})` : ''; };
  const failed = checks.filter((check) => !check.ok && !check.skipped);
  const notRun = checks.filter((check) => check.skipped === 'after-failure');
  const skipped = checks.filter((check) => check.skipped && check.skipped !== 'after-failure');
  const lines = [
    ...failed.flatMap((check) => {
      const name = `FAIL ${check.name}${note(check.script)}`;
      const failure = check.failure;
      if (!failure) return [`${name}: ${firstLine(check.error) || 'failed'}`];
      return [name, `  Expected: ${failure.expected}`, `  Happened: ${failure.happened}`,
        `  Step: ${failure.step}`, ...(failure.evidence ? [`  Evidence: ${failure.evidence}`] : [])];
    }),
    ...checks.filter((check) => check.ok).map((check) => `PASS ${check.name}${note(check.script)}`),
    ...skipped.map((check) => `SKIPPED ${check.name}${note(check.script)}: ${firstLine(check.error)}`),
    ...notRun.map((check) => `NOT RUN ${check.name}${note(check.script, 'after the first failure')}`),
  ];
  const scripts = plural(groups.length, 'script');
  if (!checks.length) lines.push(`FAILED: no check ran in ${scripts}: it stopped before its first check (its error is in the script's output).`);
  else if (failed.length) {
    const omitted = [skipped.length && `${skipped.length} skipped`, notRun.length && `${notRun.length} not run`].filter(Boolean);
    lines.push(`FAILED: ${failed.length} of ${plural(checks.length, 'check')} in ${scripts}${omitted.length ? ` (${omitted.join(', ')})` : ''}`);
  }
  // A skipped check is never a pass (tsk_6157909a): the summary names each one and why, and the run does not pass.
  else if (skipped.length) lines.push(`NOT ALL CHECKED: ${checks.length - skipped.length} passed, ${skipped.length} skipped in ${scripts}. A skipped check proves nothing: ${skipped.map((check) => `“${check.name}” (${firstLine(check.error).replace(/\.$/, '') || 'skipped'})`).join('; ')}.`);
  else lines.push(`PASSED: ${plural(checks.length, 'check')} in ${scripts}`);
  if (!checks.length) lines.push(`Next: fix the error in the script's output, then run ${TEST_COMMAND} again.`);
  else if (failed.length) lines.push(`Next: fix what each FAIL line names, run ${DEPLOY_COMMAND}, then ${TEST_COMMAND} --failed to rerun each script that failed.`);
  const files = [...new Set(groups.map((group) => group.resultFile).filter((file): file is string => Boolean(file)))];
  if (files.length && (failed.length || !checks.length || options.verbose)) lines.push(`Full result: ${files.join(', ')}`);
  return lines;
}
