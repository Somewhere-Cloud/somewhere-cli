/** No-login deploy path: mint a short-lived, unauthenticated
 *  developer credential gated by client-side proof-of-work instead of a
 *  signup. This is the whole "auth" for logged-out `somewhere deploy` — see
 *  src/commands/deploy.ts for how the minted credential is cached/reused and
 *  wired into the normal deploy flow. */

import { createHash } from 'node:crypto';
import { ApiClient, CliApiError } from './client.js';

/** GET /v1/auth/pow/challenge response payload (unauthenticated). */
export interface PowChallenge {
  nonce: string;
  difficulty: number;
  algorithm: string;
  /** The exact string the client hashes: `${nonce}:${suffix}`. Sent by the
   *  server so the client never has to guess the hash-input format. */
  input: string;
  expires_at: string;
  ttl_seconds: number;
}

/** POST /v1/auth/temp-create response payload (unauthenticated — the solved
 *  PoW is the auth). `key`/`access_token` are the same bearer credential;
 *  the server contract names both, see mintTempAccount(). */
export interface TempAccount {
  key: string;
  key_prefix?: string;
  key_id?: string;
  scopes: string[];
  expires_at: string;
  ttl_seconds: number;
  claim_token: string;
  claim_url: string;
}

/** Count LEADING ZERO BITS (not hex chars — the server's difficulty unit is
 *  bits) in a digest. Walks bytes most-significant-first and stops counting
 *  at the first 1 bit, whether that's mid-byte or in a later byte. */
export function leadingZeroBits(buf: Uint8Array): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let mask = 0x80;
    while (mask > 0 && (byte & mask) === 0) {
      bits++;
      mask >>= 1;
    }
    break;
  }
  return bits;
}

/** Sync brute-force PoW solve: try counter suffixes `0`, `1`, `2`, … (base36)
 *  until sha256(`${nonce}:${suffix}`) has at least `difficulty` leading zero
 *  bits. This is the entire cost the server imposes in place of a signup, so
 *  it must stay cheap for a real client (sub-second at difficulty ~20) — a
 *  synchronous loop is fine at that scale; no worker threads needed. */
export function solvePow(nonce: string, difficulty: number): { suffix: string; hash: string } {
  let i = 0;
  for (;;) {
    const suffix = (i++).toString(36);
    const hash = createHash('sha256').update(`${nonce}:${suffix}`, 'utf8').digest();
    if (leadingZeroBits(hash) >= difficulty) {
      return { suffix, hash: hash.toString('hex') };
    }
  }
}

/** Mint a temporary, no-login developer credential. The server may ask for a
 *  proof before issuing a key.
 *
 *  Both routes are public: the request carries no credential, never runs the
 *  stored login's refresh, and is never resent. Failures are the platform's
 *  typed errors: CliApiError with the documented `code`
 *  (RATE_LIMITED, INVALID_POW, TEMP_DEPLOYS_DISABLED, ...), HTTP status,
 *  retry / retry_after_ms and request/trace ids, and INVALID_RESPONSE with
 *  the status for a body that is not JSON. */
export async function mintTempAccount(
  client: Pick<ApiClient, 'call'> = new ApiClient(null),
  onChallenge?: () => void,
): Promise<TempAccount> {
  let data: Record<string, unknown>;
  try {
    data = await client.call<Record<string, unknown>>('POST', '/auth/temp-create', {}, undefined, { refresh: false });
  } catch (error) {
    if (!(error instanceof CliApiError) || error.code !== 'POW_REQUIRED') throw error;
    const challenge = error.data?.challenge as Partial<PowChallenge> | undefined;
    if (typeof challenge?.nonce !== 'string' || !challenge.nonce
        || typeof challenge.difficulty !== 'number' || !Number.isInteger(challenge.difficulty)
        || challenge.difficulty < 0 || challenge.difficulty > 32) throw error;
    onChallenge?.();
    const { suffix } = solvePow(challenge.nonce, challenge.difficulty);
    data = await client.call<Record<string, unknown>>(
      'POST', '/auth/temp-create', { nonce: challenge.nonce, suffix }, undefined, { refresh: false },
    );
  }
  // Prefer `key` (the field name every other stored CLI credential uses);
  // fall back to `access_token` — the contract names both.
  const key = (data?.key as string | undefined) ?? (data?.access_token as string | undefined);
  if (!key) {
    throw new CliApiError('INVALID_RESPONSE', 'The temporary account response had neither `key` nor `access_token`.', 200);
  }
  return {
    key,
    key_prefix: data.key_prefix as string | undefined,
    key_id: data.key_id as string | undefined,
    scopes: (data.scopes as string[] | undefined) ?? [],
    expires_at: data.expires_at as string,
    ttl_seconds: data.ttl_seconds as number,
    claim_token: data.claim_token as string,
    claim_url: data.claim_url as string,
  };
}
