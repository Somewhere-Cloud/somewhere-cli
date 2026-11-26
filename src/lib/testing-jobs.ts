import { API_BASE_URL, ApiClient } from './client.js';
import { loadConfig, temporaryConfigExpired, temporaryWorkspaceExpiryMessage } from './config.js';
import type { TestTarget } from './test-target.js';

export type TestJobTarget = { schedule: string } | { handler: string; payload?: unknown };
export interface TestJobOptions { timeoutSeconds?: number }
export interface TestJob {
  job_id?: string;
  request_id?: string;
  status: string;
  timed_out: boolean;
  duration_ms?: number | null;
  error_code?: string | null;
}

export function testingDeveloperToken(): string {
  const config = loadConfig();
  if (temporaryConfigExpired(config)) throw new Error(temporaryWorkspaceExpiryMessage(config.temp_expires_at));
  if (!config?.token) {
    throw new Error('Use the linked app’s CLI session to run this test.');
  }
  return config.token;
}

const terminal = new Set(['complete', 'failed', 'cancelled', 'indeterminate']);

export async function runTestJob(target: TestTarget, job: TestJobTarget, options: TestJobOptions = {}, previewCredential?: string): Promise<TestJob> {
  const time = options.timeoutSeconds ?? (previewCredential ? 270 : 300);
  if (!Number.isFinite(time) || time < 1 || time > 3600) throw new Error('Choose a job wait from 1 to 3600 seconds.');
  const preview = target.environment === 'preview';
  if (preview && (!previewCredential || !target.previewSessionId)) throw new Error('The test has no preview job credential.');
  const binding = { preview_session_id: target.previewSessionId, preview_id: target.releaseId };
  const developer = testingDeveloperToken();
  const client = new ApiClient(developer);
  let path: string;
  let body: unknown;
  let credential: string | null | undefined;
  let readJob: (id: string, waitMs: number) => Promise<{
    job_id: string; status: string; terminal?: boolean; started_at?: string | null;
    completed_at?: string | null; duration_ms?: number | null; error_code?: string | null;
    preview_session_id?: string; preview_id?: string;
  }>;
  const liveRead = (id: string, timeoutMs: number) => client.call<{ job_id: string; status: string; started_at: string | null; completed_at: string | null; error_code: string | null }>(
    'GET', `/jobs/${encodeURIComponent(id)}`, undefined, undefined, { timeoutMs });
  if ('schedule' in job) {
    const { crons } = await client.call<{ crons: Array<{ cron_id: string; name: string }> }>('GET', '/cron', undefined, { project_id: target.projectId });
    const matches = crons.filter(cron => cron.cron_id === job.schedule || cron.name === job.schedule);
    if (matches.length !== 1) throw new Error('Choose one schedule by name or ID in the linked app.');
    credential = developer;
    path = `/cron/${encodeURIComponent(matches[0].cron_id)}/${preview ? 'run-preview' : 'run'}`;
    body = preview ? binding : undefined;
    if (preview) {
      const prep = await client.call<{ notice: string; preview_session_id: string; preview_id: string }>('GET', path, undefined, binding);
      if (prep.preview_session_id !== binding.preview_session_id || prep.preview_id !== binding.preview_id || !prep.notice) {
        throw new Error('The platform did not confirm the selected preview.');
      }
      process.stderr.write(prep.notice + '\n');
      readJob = async (jobId, timeoutMs) => {
        const result = await client.call<{ preview_session_id: string; preview_id: string; job: Awaited<ReturnType<typeof readJob>> }>(
          'GET', path, undefined, { ...binding, job_id: jobId }, { timeoutMs });
        return { ...result.job, preview_id: result.preview_id, preview_session_id: result.preview_session_id };
      };
    } else readJob = liveRead;
  } else {
    if (!job.handler.startsWith('/') || new URL(job.handler, target.origin).origin !== target.origin) throw new Error('Choose a handler path in this app.');
    path = preview ? `/projects/${encodeURIComponent(target.projectId)}/preview/run-job` : '/jobs';
    body = { handler: job.handler, payload: job.payload, ...(preview ? binding : { project_id: target.projectId }) };
    credential = developer;
    const tool = new ApiClient(previewCredential ?? null);
    readJob = preview
      ? (id, timeoutMs) => tool.call('GET', `/preview-tools/jobs/${encodeURIComponent(id)}`, undefined, undefined, { refresh: false, timeoutMs })
      : liveRead;
  }

  const encoded = body === undefined ? undefined : JSON.stringify(body);
  let requestId: string | undefined;
  let receipt: { job_id?: string; timeout_seconds?: number; preview_session_id?: string; preview_id?: string } | undefined;
  try {
    const response = await fetch(API_BASE_URL + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: encoded,
    });
    requestId = response.headers.get('x-request-id') ?? response.headers.get('cf-ray') ?? undefined;
    const answer = await response.json() as { ok?: boolean; error?: string; data?: typeof receipt } | null;
    if (response.status >= 400 && response.status < 500 && answer?.ok === false) {
      return { status: 'refused', request_id: requestId, timed_out: false, error_code: answer.error };
    }
    if (response.status === 202 && answer?.ok === true) receipt = answer.data;
  } catch {
    // A connection or body failure does not say whether the job was admitted.
  }
  const validTarget = (value: { preview_session_id?: string; preview_id?: string }) =>
    !preview || value.preview_session_id === binding.preview_session_id && value.preview_id === binding.preview_id;
  if (typeof receipt?.job_id !== 'string' || !receipt.job_id.startsWith('job_') || !validTarget(receipt)) return { status: 'unknown', request_id: requestId, timed_out: false };
  const id = receipt.job_id;
  const budget = preview ? Math.min(time, receipt.timeout_seconds || 270) : time;
  const deadline = Date.now() + budget * 1000;
  let status = 'queued';
  while (Date.now() < deadline) {
    try {
      const job = await readJob(id, Math.max(1, deadline - Date.now()));
      if (job.job_id !== id || !validTarget(job)) throw new Error('Unexpected job receipt.');
      status = job.status;
      if (job.terminal ?? (terminal.has(status) && typeof job.completed_at === 'string')) {
        const duration = job.duration_ms ?? (job.started_at && job.completed_at ? Date.parse(job.completed_at) - Date.parse(job.started_at) : null);
        return { status, job_id: id, request_id: requestId, duration_ms: duration, timed_out: false, error_code: job.error_code };
      }
    } catch {
      return { status: 'unknown', job_id: id, request_id: requestId, timed_out: false };
    }
    const wait = Math.min(1000, deadline - Date.now());
    if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
  }
  return { status, job_id: id, request_id: requestId, timed_out: true };
}
