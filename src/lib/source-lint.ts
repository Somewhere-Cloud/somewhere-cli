import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { genericLint, type GenericLintResult } from './generic-lint.js';
import { collectFiles } from './files.js';

export interface LintFinding {
  rule: string;
  severity: 'warning';
  file: string;
  line: number;
  message: string;
  fix: string;
  docs: string;
}
export interface SourceLintSnapshot {
  version: string;
  findings: LintFinding[];
  source_sha256: string;
  schema_sha256: string | null;
  coverage: { schema: 'checked' | 'absent'; authorization: 'not-assessed' };
}
interface SourceLintVendor {
  lintSourceSnapshot(files: Record<string, string>, functions: Record<string, string>): Promise<SourceLintSnapshot>;
}
export interface LocalLintResult extends SourceLintSnapshot {
  ok: boolean;
  duration_ms: number;
  checked_files: number;
  skipped: Array<{ path: string; reason: string }>;
  generic: GenericLintResult;
}

/** Same collector as deploy, same rule source as the platform. No installs,
 * network, generated-file writes or automatic fixes. Optional generic rules
 * run the project's installed linter in a child process. */
export async function lintProject(directory: string, options: { generic?: boolean } = {}): Promise<LocalLintResult> {
  const started = performance.now();
  const collected = collectFiles(directory);
  const require = createRequire(import.meta.url);
  const vendor = require('../../runtime/source-lint.cjs') as SourceLintVendor;
  const report = await vendor.lintSourceSnapshot(collected.files, collected.functions);
  const generic: GenericLintResult = options.generic ? genericLint(directory) : { status: 'not-requested', findings: [] };
  return {
    ...report,
    ok: collected.skipped.length === 0 && !['failed', 'unavailable'].includes(generic.status),
    duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
    checked_files: Object.keys(collected.files).length + Object.keys(collected.functions).length,
    skipped: collected.skipped,
    generic,
  };
}
