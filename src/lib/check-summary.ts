export interface CheckSummary {
  outcome: 'passed' | 'failed' | 'could_not_check';
  counts: { passed: number; failed: number; could_not_check: number; warnings: number };
}

export function summarizeChecks(counts: CheckSummary['counts']): CheckSummary {
  return { outcome: counts.failed ? 'failed' : counts.could_not_check ? 'could_not_check' : 'passed', counts };
}

export function checkSummaryExitCode(summary: CheckSummary): number {
  return summary.outcome === 'failed' ? 1 : summary.outcome === 'could_not_check' ? 2 : 0;
}
