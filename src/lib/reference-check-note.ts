// `somewhere test` starts with one line about the live release's background reference check, only when it is not
// clean: the deploy can only say the check is running, and its result is otherwise read by hand (bench-1115c:
// three builders never saw it).

interface ReferenceCheck { status?: string; reason?: string; findings?: number }
export interface DeployLogRead { version?: number; reference_check?: ReferenceCheck | null }
interface LogClient { call<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> }

/** The line for this log, or null when the check is clean, still running, or absent. */
export function describeReferenceCheck(log: DeployLogRead | null): string | null {
  const check = log?.reference_check;
  if (!check || typeof log?.version !== 'number') return null;
  const read = `somewhere call project_deploy_log '${JSON.stringify({ version: log.version })}'`;
  if (check.status === 'checked' && (check.findings ?? 0) > 0) {
    return `The last deploy's background reference check found ${check.findings} warning${check.findings === 1 ? '' : 's'}; read them with: ${read}`;
  }
  if (check.status === 'unavailable') {
    return `The last deploy's background reference check ${check.reason === 'not_finished' ? 'never finished' : 'could not run'}, so its warnings are unknown: ${read}`;
  }
  return null;
}

/** Read the live release's log once and return the line to print, if any. A failed read says so. */
export async function referenceCheckNote(client: () => LogClient, projectId: string): Promise<string | null> {
  try {
    return describeReferenceCheck(await client().call<DeployLogRead>('GET', '/deploy/log', undefined, { project_id: projectId }));
  } catch (error) {
    return `Could not read the last deploy's background reference check: ${error instanceof Error ? error.message : String(error)}`;
  }
}
