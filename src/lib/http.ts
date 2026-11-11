import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { recordPlatformContract } from './platform-contract.js';

// CLI processes inherit their network configuration at startup. Reuse pools
// within each timeout budget; EnvHttpProxyAgent handles HTTP(S)_PROXY and
// NO_PROXY (including lowercase variants), and connects directly without a
// proxy. Keep fetch and dispatcher from the same bundled undici instance.
const dispatchers = new Map<number, EnvHttpProxyAgent>();

export function fetchWithProxy(
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
  timeoutMs = 60_000,
): ReturnType<typeof undiciFetch> {
  let dispatcher = dispatchers.get(timeoutMs);
  if (!dispatcher) {
    dispatcher = new EnvHttpProxyAgent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    dispatchers.set(timeoutMs, dispatcher);
  }
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: string }).url ?? '';
  return undiciFetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    dispatcher,
  }).catch((err: unknown) => {
    throw describeNetworkFailure(err, url);
  }).then((response) => {
    // Every platform response names the consumer contract it implements (X-SW-Consumer-Contract);
    // keeping the last one lets typecheck and lint say when this CLI is out of date, offline.
    // A response without the header (npm, third parties) records nothing. The record is
    // advisory: if it cannot be written, the next local check says "unknown", never "current".
    try { recordPlatformContract(response.headers, url); } catch { /* reported as unknown by the next check */ }
    return response;
  });
}

/** Undici rejects a request that got no response with a bare "fetch failed"
 *  and hides the reason in `cause`. Every CLI request goes through here, so
 *  every such failure names the host it tried, the reason, and what to do
 *  (tsk_b9900dbb: `somewhere login` in a sandboxed agent shell printed only
 *  "fetch failed"). Timeouts and aborts pass through for their own messages;
 *  `cause` is kept so callers that read `cause.code` still can. */
export function describeNetworkFailure(err: unknown, url: string): unknown {
  if (!(err instanceof Error) || err.name === 'TimeoutError' || err.name === 'AbortError') return err;
  if (err.message !== 'fetch failed') return err;
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code;
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return err;
  let host = url;
  let origin = url;
  try { ({ host, origin } = new URL(url)); } catch { /* keep the raw url */ }
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const reason = [code, cause?.message && cause.message !== code ? cause.message : undefined].filter(Boolean).join(': ') || 'no response';
  const failure = new Error(
    `Could not reach ${host} (${reason}). No response was received${proxy ? ' through this shell\'s proxy' : ''}. ` +
      `Check that this computer can open ${origin}; if this shell only allows listed sites (an agent sandbox), add ${host}, or run the command in your own terminal.`,
    { cause },
  );
  failure.name = 'NetworkError';
  return failure;
}
