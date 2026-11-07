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
  }).then((response) => {
    // Every platform response names the consumer contract it implements (X-SW-Consumer-Contract);
    // keeping the last one lets typecheck and lint say when this CLI is out of date, offline.
    // A response without the header (npm, third parties) records nothing. The record is
    // advisory: if it cannot be written, the next local check says "unknown", never "current".
    try { recordPlatformContract(response.headers, url); } catch { /* reported as unknown by the next check */ }
    return response;
  });
}
