/**
 * A refusal that left the new version live.
 *
 * Some failures happen after the platform switched production to the new
 * version: its page rendered blank and the automatic switch back was not
 * allowed (409 AUTO_ROLLBACK_BLOCKED, data.live true), or the post-live blank
 * check could not roll it back (DEPLOY_BLANK_PAGE with POSTVERIFY_ROLLBACK_BLOCKED
 * or POSTVERIFY_RECOVERY_FAILED). The platform names the release it published
 * (data.release_id) and the one serving now (data.active_release_id): when they
 * are the same, this version is live, whatever the code. The CLI then says so,
 * and a deploy records that release as the folder's base so the corrected
 * deploy the message asks for is admitted without --force.
 */
import { CliApiError } from './client.js';

export interface LiveRefusal {
  code: string;
  releaseId: string;
  /** The live version number when the platform stated it. */
  version: number | null;
}

/** The live release a refusal left behind, or null when it left production as it was (or did not say). */
export function liveRefusal(err: unknown): LiveRefusal | null {
  if (!(err instanceof CliApiError) || !err.data || typeof err.data !== 'object') return null;
  const data = err.data;
  const releaseId = typeof data.release_id === 'string' && data.release_id ? data.release_id : null;
  if (!releaseId) return null;
  const active = typeof data.active_release_id === 'string' && data.active_release_id ? data.active_release_id : null;
  // The pointer is the authority: a refusal is live only when production serves this very release.
  if (active !== releaseId) return null;
  return { code: err.code, releaseId, version: typeof data.version === 'number' ? data.version : null };
}

/**
 * The plain statement for a live refusal. The platform's own message already says it when it begins with
 * "This version is live"; any other message is the reason, framed so it never reads as "nothing happened".
 */
export function formatLiveRefusalMessage(message: string): string {
  const text = message.trim();
  if (/^This version is live\b/.test(text)) return text;
  const nextStep = /\bDeploy a (corrected|working) version\b|\bA deploy of a working version\b/i.test(text)
    ? '' : ' Deploy a corrected version to replace it.';
  return `This version is live, but it failed its check and could not be switched back automatically: ${text}${nextStep}`;
}
