import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { cliConfigDir } from './config.js';

/**
 * Which platform consumer contract this CLI implements, and whether the platform it talks to has
 * moved on. `somewhere typecheck` and `somewhere lint` judge a project by the
 * platform code this CLI vendors (runtime/declared-data.cjs, runtime/source-lint.cjs). That
 * bundle carries CONSUMER_CONTRACT { version, digest }; every platform API response announces
 * its own on X-SW-Consumer-Contract. The last announcement per API origin is kept in
 * <config dir>/platform-contract.json, so the local checks can say "this CLI is out of date"
 * offline, and say "unknown" when nothing has been recorded, instead of guessing.
 *
 * Limit, stated to the user in the verdict message: the local checks know only the LAST OBSERVED
 * announcement. "current" means "matches what this machine last saw", not a freshness guarantee; a
 * platform release since then stays unknown until a command next talks to the platform. No record,
 * offline use, another API origin or an unreadable record is "unknown", never "current".
 *
 * Nothing is downloaded or executed: only the announced version and digest are stored. typecheck and
 * lint make no network or model call; recording happens only when other commands already talk to the
 * platform.
 */
const require = createRequire(import.meta.url);

export const CONTRACT_HEADER = 'x-sw-consumer-contract';
export interface ConsumerContract { version: number; digest: string }
export interface SeenPlatformContract extends ConsumerContract { seen_at: number; origin: string }
export interface ContractVerdict {
  status: 'unknown' | 'current' | 'outdated' | 'ahead' | 'mismatch';
  compatible: boolean | null;
  message: string;
  cli: ConsumerContract | null;
  platform: SeenPlatformContract | null;
}
interface ContractVendor {
  CONSUMER_CONTRACT?: ConsumerContract;
  parseConsumerContractHeader(value: string | null | undefined): ConsumerContract | null;
  consumerContractVerdict(cli: ConsumerContract | null | undefined, seen: SeenPlatformContract | null | undefined, now?: number): Omit<ContractVerdict, 'cli' | 'platform'>;
}
const vendor = (): ContractVendor => require('../../runtime/declared-data.cjs') as ContractVendor;
const seenPath = () => join(cliConfigDir(), 'platform-contract.json');

/** The CLI's own contract, from the vendored platform bundle (null: a bundle from before it existed). */
export function cliConsumerContract(): ConsumerContract | null {
  return vendor().CONSUMER_CONTRACT ?? null;
}

type SeenFile = { origins: Record<string, SeenPlatformContract> };
function readSeenFile(): SeenFile {
  if (!existsSync(seenPath())) return { origins: {} };
  try {
    const value = JSON.parse(readFileSync(seenPath(), 'utf8')) as Partial<SeenFile>;
    return value && typeof value === 'object' && value.origins && typeof value.origins === 'object' ? { origins: value.origins } : { origins: {} };
  } catch {
    // An unreadable record is the same as none: the verdict says "unknown", never "current".
    return { origins: {} };
  }
}

/** Keep the contract a platform response announced. A response without the header changes nothing. */
export function recordPlatformContract(headers: { get(name: string): string | null }, url: string, now = Date.now()): SeenPlatformContract | null {
  const announced = vendor().parseConsumerContractHeader(headers.get(CONTRACT_HEADER));
  if (!announced) return null;
  let origin: string;
  try { origin = new URL(url).origin; } catch { return null; }
  const file = readSeenFile();
  const seen: SeenPlatformContract = { ...announced, seen_at: now, origin };
  file.origins[origin] = seen;
  mkdirSync(cliConfigDir(), { recursive: true, mode: 0o700 });
  writeFileSync(seenPath(), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  warnContract({ ...vendor().consumerContractVerdict(cliConsumerContract(), seen, now), cli: cliConsumerContract(), platform: seen });
  return seen;
}

/** The last contract seen from `apiBase`'s origin, or null. */
export function seenPlatformContract(apiBase: string): SeenPlatformContract | null {
  let origin: string;
  try { origin = new URL(apiBase).origin; } catch { return null; }
  const seen = readSeenFile().origins[origin];
  return seen && Number.isInteger(seen.version) && /^[0-9a-f]{64}$/.test(seen.digest) ? seen : null;
}

/** Whether this CLI may judge code for the platform at `apiBase`. */
export function platformContractVerdict(apiBase: string, now = Date.now()): ContractVerdict {
  const cli = cliConsumerContract();
  const platform = seenPlatformContract(apiBase);
  const verdict = { ...vendor().consumerContractVerdict(cli, platform, now), cli, platform };
  warnContract(verdict);
  return verdict;
}

/** Contract drift is advisory; each command prints at most one plain line. */
let warned = false;
function warnContract(verdict: ContractVerdict): void {
  if (warned || verdict.compatible !== false) return;
  warned = true;
  console.error(`Warning: CLI consumer contract ${verdict.cli?.version ?? 'unknown'} differs from platform ${verdict.platform?.version ?? 'unknown'}; continuing with this CLI's checks.`);
}
