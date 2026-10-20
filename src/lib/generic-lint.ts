import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LintFinding } from './source-lint.js';

export interface GenericLintResult {
  status: 'not-requested' | 'completed' | 'unavailable' | 'failed';
  findings: LintFinding[];
  reason?: string;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// The checker is project-installed code: hand it no account credentials.
function checkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'NO_COLOR']) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

/** Use the project's existing Oxlint installation. Never download a binary or
 * install packages during an ordinary lint run. Type-aware rules are separate. */
export function genericLint(directory: string): GenericLintResult {
  const launcher = join(directory, 'node_modules', 'oxlint', 'bin', 'oxlint');
  if (!existsSync(launcher)) return {
    status: 'unavailable', findings: [],
    reason: 'Oxlint is not installed in this project. Install it with npm install --save-dev oxlint, then rerun with --generic.',
  };
  const result = spawnSync(process.execPath, [launcher, '--format', 'json', '--react-plugin', '--promise-plugin', '-W', 'correctness',
    '--ignore-pattern', '**/node_modules/**', '--ignore-pattern', '**/dist/**', '--ignore-pattern', '**/build/**', '.'], {
    cwd: directory, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: checkerEnv(),
  });
  if (result.error || result.status === null) return { status: 'failed', findings: [], reason: result.error?.message ?? 'Oxlint was interrupted.' };
  try {
    const report = record(JSON.parse(result.stdout) as unknown);
    if (!Array.isArray(report?.diagnostics)) throw new Error('Oxlint did not return its JSON diagnostics array.');
    const findings: LintFinding[] = report.diagnostics.map((value: unknown) => {
      const diagnostic = record(value);
      if (!diagnostic || typeof diagnostic.message !== 'string') throw new Error('Unrecognized Oxlint diagnostic.');
      const first = Array.isArray(diagnostic.labels) ? record(diagnostic.labels[0]) : null;
      const span = record(first?.span);
      return {
        rule: typeof diagnostic.code === 'string' ? diagnostic.code : 'oxlint/syntax',
        severity: 'warning',
        file: typeof diagnostic.filename === 'string' ? diagnostic.filename : '<project>',
        line: typeof span?.line === 'number' ? span.line : 1,
        message: diagnostic.message,
        fix: typeof diagnostic.help === 'string' ? diagnostic.help : 'Review the indicated expression and the rule documentation.',
        docs: typeof diagnostic.url === 'string' ? diagnostic.url : 'https://oxc.rs/docs/guide/usage/linter.html',
      };
    });
    if (result.status !== 0 && (result.status !== 1 || findings.length === 0)) {
      return { status: 'failed', findings, reason: `Oxlint exited ${result.status}. ${result.stderr.trim()}` };
    }
    return { status: 'completed', findings };
  } catch (error) {
    return { status: 'failed', findings: [], reason: error instanceof Error ? error.message : String(error) };
  }
}
