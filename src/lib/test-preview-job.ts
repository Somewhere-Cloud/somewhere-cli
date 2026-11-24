import { ApiClient, CliApiError } from './client.js';
import { getToken } from './config.js';
import { previewCurrentVersion, type FolderPreview } from './preview-jobs.js';

type Counts = Record<string, number>;
type Observation = {
  notice: string;
  preview_session_id: string;
  preview_id: string;
  row_counts?: Counts | null;
  row_counts_reason?: string;
  job?: { job_id: string; status: string; terminal: boolean; duration_ms: number | null; error_code: string | null };
};
type Target = Pick<Observation, 'preview_session_id' | 'preview_id'>;
type Run = {
  status: string;
  job_id?: string;
  request_id?: string;
  duration_ms: number | null;
  detail?: string;
  row_count_changes?: Array<{ table: string; before: number; after: number }>;
  row_counts_reason?: string;
};

function rowCountChanges(before?: Counts | null, after?: Counts | null): Run['row_count_changes'] {
  if (!before || !after || Object.keys(before).length !== Object.keys(after).length) return undefined;
  if (Object.keys(before).some((table) => !Object.hasOwn(after, table))) return undefined;
  return Object.keys(after).sort().filter((table) => before[table] !== after[table])
    .map((table) => ({ table, before: before[table], after: after[table] }));
}

export async function runPreviewScheduleTest(
  client: Pick<ApiClient, 'call' | 'callRaw'>, cronId: string, target: Target, twice: boolean,
  report: (message: string) => void,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<Run[]> {
  const path = `/cron/${encodeURIComponent(cronId)}/run-preview`;
  const validTarget = (value: Target) => value.preview_session_id === target.preview_session_id && value.preview_id === target.preview_id;
  const first = await client.call<Observation>('GET', path, undefined, { ...target, counts: twice ? 1 : undefined });
  if (!validTarget(first) || !first.notice) throw new Error('The platform did not confirm the preview job test target.');
  report(first.notice);
  let before = first.row_counts;
  let countsReason = first.row_counts_reason;
  const runs: Run[] = [];
  for (let index = 0; index < (twice ? 2 : 1); index++) {
    let requestId: string | undefined;
    let jobId: string | undefined;
    let timeoutSeconds = 270;
    try {
      // One POST. Raw transport has no login refresh or redirect replay.
      const response = await client.callRaw('POST', path, target, { captureIncompleteBody: true, redirect: 'error' });
      requestId = response.headers['x-request-id'] ?? response.headers['cf-ray'];
      const envelope = JSON.parse(response.body) as { error?: string; message?: string; data?: Partial<Target> & { job_id?: string; timeout_seconds?: number } };
      if (response.status >= 400 && response.status < 500 && typeof envelope.error === 'string') {
        runs.push({ status: 'refused', duration_ms: null, request_id: requestId, detail: envelope.message ?? envelope.error });
        break;
      }
      const data = envelope.data;
      if (response.status === 202 && data && data.preview_session_id === target.preview_session_id && data.preview_id === target.preview_id
          && typeof data.job_id === 'string' && data.job_id.startsWith('job_')) {
        jobId = data.job_id;
        if (typeof data.timeout_seconds === 'number' && data.timeout_seconds > 0) timeoutSeconds = Math.min(data.timeout_seconds, timeoutSeconds);
      }
    } catch (error) {
      if (error instanceof CliApiError) requestId = error.meta.requestId ?? requestId;
    }
    if (!jobId) {
      runs.push({ status: 'unknown', duration_ms: null, request_id: requestId, detail: 'Job admission is unknown. The request was not resubmitted.' });
      break;
    }
    report(`Queued job ${jobId}${requestId ? ` (request ${requestId})` : ''}.`);
    const deadline = Date.now() + timeoutSeconds * 1000;
    let last: Observation | undefined;
    let readFailed = false;
    while (Date.now() < deadline) {
      try {
        const result: Observation = await client.call<Observation>('GET', path, undefined, { ...target, job_id: jobId, counts: twice ? 1 : undefined },
          { timeoutMs: Math.max(1, deadline - Date.now()), refresh: false });
        if (!validTarget(result) || result.job?.job_id !== jobId) throw new Error('Unexpected job status receipt');
        last = result;
        if (result.job.terminal) break;
      } catch {
        readFailed = true;
        break;
      }
      if (Date.now() < deadline) await sleep(Math.min(1000, deadline - Date.now()));
    }
    const job = last?.job;
    if (!job?.terminal || job.status === 'indeterminate') {
      const detail = readFailed ? 'The job status could not be read.'
        : job?.terminal ? 'The job’s execution outcome is indeterminate.' : 'The job did not reach a terminal status before the wait expired.';
      runs.push({ status: 'unknown', duration_ms: job?.duration_ms ?? null, job_id: jobId, request_id: requestId, detail });
      break;
    }
    const changes = twice ? rowCountChanges(before, last?.row_counts) : undefined;
    runs.push({
      status: job.status, duration_ms: job.duration_ms, job_id: jobId, request_id: requestId,
      ...(job.error_code ? { detail: job.error_code } : {}),
      ...(twice ? (changes ? { row_count_changes: changes }
        : { row_counts_reason: last?.row_counts_reason ?? countsReason ?? 'Two comparable row count snapshots were unavailable.' }) : {}),
    });
    before = last?.row_counts;
    countsReason = last?.row_counts_reason;
  }
  return runs;
}

export async function printPreviewScheduleTest(cronId: string, preview: FolderPreview, twice: boolean, json: boolean): Promise<void> {
  const { preview_session_id, preview_id } = await previewCurrentVersion(preview.credential);
  const version = { preview_session_id, preview_id };
  if (preview.previewSessionId !== version.preview_session_id) throw new Error('The preview credential did not resolve to this folder’s preview.');
  const runs = await runPreviewScheduleTest(new ApiClient(getToken()), cronId, version, twice, (message) => process.stderr.write(message + '\n'));
  if (json) process.stdout.write(JSON.stringify({ cron_id: cronId, ...version, runs }) + '\n');
  else runs.forEach((run, i) => {
    const receipt = [run.job_id && `job ${run.job_id}`, run.request_id && `request ${run.request_id}`].filter(Boolean).join(', ');
    const duration = run.duration_ms !== null ? ` in ${(run.duration_ms / 1000).toFixed(2)} s` : '';
    console.log(`Run ${i + 1} ${run.status}${duration}${receipt ? ` (${receipt})` : ''}.${run.detail ? ` ${run.detail}` : ''}`);
    if (run.row_count_changes) {
      const changes = run.row_count_changes.map(({ table, before, after }) => `${table} ${before} → ${after}`);
      console.log(changes.length ? `Observed row counts changed in ${changes.join(', ')}.` : 'No declared table row count changed between reads.');
    }
    if (run.row_counts_reason) console.log(`Row count observation unavailable. ${run.row_counts_reason}`);
  });
  process.exitCode = runs.some((run) => ['failed', 'cancelled'].includes(run.status)) ? 1
    : runs.every((run) => run.status === 'complete') ? 0 : 2;
}
