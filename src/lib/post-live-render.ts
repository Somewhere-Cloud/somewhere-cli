/**
 * Close the loop on a release whose blank-page check runs after the deploy
 * answered.
 *
 * A release that can be undone by moving the live pointer answers before its
 * browser check, with post_live_render: { status: 'pending' }. The check takes
 * 0.7-2.8 s and rolls a blank page back. The CLI waits for it, up to
 * POST_LIVE_RENDER_WAIT_MS, by reading GET /deploy/log?release_id=:
 *   - settled and passed: the deploy result gains that blank_page_check;
 *   - rendered blank: the platform returns the same DEPLOY_BLANK_PAGE body a
 *     gated first deploy answers with, raised here as that same error;
 *   - not settled in time: the deploy is live and the line below says the
 *     check is still running.
 */
import { CliApiError, type ApiClient } from './client.js';

export const POST_LIVE_RENDER_WAIT_MS = 5000;
export const POST_LIVE_RENDER_POLL_MS = 100;
export const POST_LIVE_RENDER_STILL_RUNNING = "Render check still running; see its result with: somewhere call project_deploy_log '{}'";

export interface PostLiveRenderRecord {
  status: string;
  blank_page_check?: unknown;
  warning?: string;
  message?: string;
  active_release_id?: string | null;
}

interface ReleaseRenderRead {
  post_live_render?: PostLiveRenderRecord | null;
  blank_page_check?: unknown;
  rejection?: { error?: string; message?: string; data?: Record<string, unknown>; hint?: string };
}

export type PostLiveRenderWait =
  | { kind: 'not_pending' }
  | { kind: 'settled'; post_live_render: PostLiveRenderRecord; blank_page_check: unknown }
  | { kind: 'timeout' };

/** Wait for a pending render check. Throws the DEPLOY_BLANK_PAGE CliApiError
 *  when the release rendered blank. A read that fails is retried until the
 *  deadline; never success by default. */
export async function awaitPostLiveRender(
  client: Pick<ApiClient, 'call'>,
  projectId: string | undefined,
  result: { release_id?: string; post_live_render?: { status?: string } | null },
  opts: { waitMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PostLiveRenderWait> {
  if (result.post_live_render?.status !== 'pending' || !result.release_id || !projectId) return { kind: 'not_pending' };
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let pollMs = opts.pollMs ?? POST_LIVE_RENDER_POLL_MS;
  let nextDelayMs = opts.pollMs ?? 0;
  const deadline = now() + (opts.waitMs ?? POST_LIVE_RENDER_WAIT_MS);
  while (now() < deadline) {
    if (nextDelayMs) await sleep(Math.min(nextDelayMs, Math.max(0, deadline - now())));
    nextDelayMs = pollMs;
    pollMs = opts.pollMs ?? Math.min(400, pollMs * 2);
    let read: ReleaseRenderRead;
    try {
      read = await client.call<ReleaseRenderRead>('GET', '/deploy/log', undefined,
        { project_id: projectId, release_id: result.release_id }, { timeoutMs: Math.max(1000, deadline - now()) });
    } catch {
      continue;
    }
    if (read?.rejection?.error) {
      const r = read.rejection;
      throw new CliApiError(r.error!, r.message ?? 'The page rendered blank.', 400, r.data, r.hint);
    }
    const record = read?.post_live_render;
    if (record && record.status !== 'pending') {
      return { kind: 'settled', post_live_render: record, blank_page_check: read.blank_page_check ?? record.blank_page_check ?? null };
    }
  }
  return { kind: 'timeout' };
}
