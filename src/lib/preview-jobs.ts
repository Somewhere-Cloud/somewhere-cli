import { cliInvocation } from './cli-invocation.js';
// Preview jobs from the CLI: `somewhere preview run-job` and `somewhere cron run --preview`.
// Every call about the preview's own jobs carries ONLY that preview's tool credential (lib/preview-credential.ts); your
// own sign-in is used for nothing but minting it, and a production job read never sees a preview job.
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiClient, CliApiError } from './client.js';
import { interactivePollDelay } from './poll-delay.js';
import { getToken, loadProjectConfig } from './config.js';
import { loadPreviewCredential, mintPreviewCredential, previewToolClient } from './preview-credential.js';
import { loadPreviewRecord } from './preview-record.js';

export interface FolderPreview { projectId: string; previewSessionId: string; credential: string }

/** This folder's open preview (or the one named) and its tool credential. */
export async function folderPreviewTool(opts: { project?: string; previewSession?: string }): Promise<FolderPreview> {
  const projectId = opts.project ?? loadProjectConfig()?.project_id;
  if (!projectId) throw new Error(`No project linked. Run \`${cliInvocation()} init\` or pass --project <id>.`);
  const previewSessionId = opts.previewSession ?? loadPreviewRecord(process.cwd(), projectId)?.preview_session_id;
  if (!previewSessionId) throw new Error(`This folder has no open preview. Open one with \`${cliInvocation()} preview\`, or name one with --preview-session <id> (\`${cliInvocation()} preview list\`).`);
  const credential = loadPreviewCredential(projectId, previewSessionId)
    ?? await mintPreviewCredential(new ApiClient(getToken()), projectId, previewSessionId);
  return { projectId, previewSessionId, credential };
}

/** The preview's current version, as the platform resolves it for this credential. */
export async function previewCurrentVersion(credential: string): Promise<{ preview_session_id: string; preview_id: string }> {
  return previewToolClient(credential).call<{ preview_session_id: string; preview_id: string }>('GET', '/preview-tools/whoami');
}

export interface PreviewJob {
  job_id: string; status: string; handler: string; result: unknown; error: string | null; error_code: string | null;
  timeout_seconds: number; attempts_allowed: number; preview_session_id: string; preview_id: string;
}

const TERMINAL = new Set(['complete', 'failed', 'cancelled', 'indeterminate']);

/** Waits for a preview job to finish, reading it through the preview's own credential. */
export async function waitForPreviewJob(credential: string, jobId: string, timeoutSeconds: number, firstDelayMs = 0): Promise<{ job: PreviewJob; timedOut: boolean }> {
  const client = previewToolClient(credential);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let job: PreviewJob | undefined;
  let delay = firstDelayMs;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (delay >= remaining) {
      if (remaining > 0) await sleep(remaining);
      if (job) return { job, timedOut: true };
      throw new Error('The wait expired before the platform returned the preview job status.');
    }
    if (delay) await sleep(delay);
    let retryAfter = 0;
    try {
      job = await client.call<PreviewJob>('GET', `/preview-tools/jobs/${encodeURIComponent(jobId)}`, undefined, undefined, {
        onRetryAfter: (ms) => { retryAfter = ms; },
      });
      if (TERMINAL.has(job.status)) return { job, timedOut: false };
    } catch (error) {
      if (!(error instanceof CliApiError) || error.meta.retryAfterMs === undefined) throw error;
      retryAfter = Math.max(retryAfter, error.meta.retryAfterMs);
    }
    delay = Math.max(interactivePollDelay(attempt), retryAfter);
  }
}
