import { cliInvocation } from './cli-invocation.js';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { ClaimAppAccess, ClaimCliHandoff, ClaimCliHandoffAck, CliConfig } from '../types.js';
import { loadConfig, saveConfig, temporaryConfigExpired } from './config.js';
import { getDeviceKeyName } from './device.js';
import { describeThisDevice } from './device-login.js';
import { API_BASE_URL, type ApiClient } from './client.js';
import { fetchWithProxy as fetch } from './http.js';

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

interface RegisterResult { handoff_id: string; expires_at: string }
interface ExchangeResult { status: 'ready'; project_id: string; approved_scope?: string; ciphertext: string; iv: string }
interface DeliveredCredentials {
  token: string;
  refresh_token: string | null;
  expires_at: string;
  email: string;
  project_id: string;
  scope: { projects: string[] };
  approved_scope?: string;
  session_id: string;
  credential_kind?: 'project_agent';
  claim_access?: ClaimAppAccess;
}

interface ClaimConnection {
  state: 'claimed_connected' | 'claimed_disconnected';
  claim_access?: ClaimAppAccess;
  can_create_projects?: boolean;
  projects_remaining?: number;
  projects?: { project_id: string; name: string; url: string; can_deploy: boolean; reason: string | null }[];
}

export function readClaimConnection(client: Pick<ApiClient, 'call'>): Promise<ClaimConnection> {
  return client.call<ClaimConnection>('GET', '/auth/temp-claim/status', undefined, undefined, { refresh: false });
}

type HttpResponse = Awaited<ReturnType<typeof fetch>>;

export interface ClaimHandoffRecovery {
  /** stale: the temporary session and its continuation have both expired; a
   *  note, never a blocker. */
  kind: 'none' | 'recovered' | 'manual' | 'stale';
  message?: string;
}

function verifierHash(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('hex');
}

function newVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function decodeCredentials(state: ClaimCliHandoff, response: ExchangeResult): DeliveredCredentials {
  if (!state.handoff_id || response.project_id !== state.project_id) {
    throw new Error('Claim continuation returned a different project. No credential was installed.');
  }
  const key = createHash('sha256').update(`claim-cli-handoff:v1:${state.verifier}`, 'utf8').digest();
  const combined = Buffer.from(response.ciphertext, 'base64');
  if (combined.length <= 16) throw new Error('Claim continuation returned an invalid credential payload.');
  const encrypted = combined.subarray(0, -16);
  const tag = combined.subarray(-16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(response.iv, 'base64'));
  decipher.setAAD(Buffer.from(`${state.handoff_id}:${state.project_id}`, 'utf8'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plaintext) as Partial<DeliveredCredentials>;
  const projects = parsed.scope?.projects;
  const agent = parsed.credential_kind === 'project_agent';
  if (
    typeof parsed.token !== 'string'
    || !parsed.token
    || typeof parsed.expires_at !== 'string'
    || typeof parsed.email !== 'string'
    || parsed.project_id !== state.project_id
    || (parsed.approved_scope !== undefined && parsed.approved_scope !== 'project')
    || !Array.isArray(projects)
    || !projects.includes(state.project_id)
    || projects.some(project => typeof project !== 'string' || !project)
    || (agent
      ? parsed.refresh_token !== null || (parsed.claim_access !== 'new_projects' && parsed.claim_access !== 'all_projects')
      : parsed.credential_kind !== undefined || parsed.claim_access !== undefined || typeof parsed.refresh_token !== 'string' || projects.length !== 1)
  ) {
    throw new Error('Claim continuation credential did not match the approved project. Nothing was installed.');
  }
  return parsed as DeliveredCredentials;
}

async function post<T>(path: string, body: unknown, token?: string): Promise<{ response: HttpResponse; envelope: Envelope<T> }> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }, 15_000);
  const envelope = await response.json() as Envelope<T>;
  return { response, envelope };
}

/** Persist the verifier before registration so a lost response retries with
 * the same proof instead of creating an irrecoverable second request. */
export async function ensureClaimHandoff(projectId: string): Promise<ClaimCliHandoff | null> {
  const config = loadConfig();
  if (!config?.temporary || !config.token) return null;
  let state = config.claim_handoff;
  if (!state || state.project_id !== projectId) {
    state = { project_id: projectId, verifier: newVerifier() };
    saveConfig({ ...config, claim_handoff: state });
  }
  if (state.handoff_id) return state;

  const { response, envelope } = await post<RegisterResult>('/auth/temp-handoff/register', {
    project_id: projectId,
    verifier_hash: verifierHash(state.verifier),
    device_name: getDeviceKeyName(),
    client: { hostname: describeThisDevice().hostname },
    capabilities: ['claim_project_agent_v1'],
  }, config.token);
  if (!response.ok || !envelope.ok || !envelope.data) {
    throw new Error(envelope.message || envelope.error || `CLI continuation registration failed (HTTP ${response.status}).`);
  }
  const registered = { ...state, handoff_id: envelope.data.handoff_id, expires_at: envelope.data.expires_at };
  const current = loadConfig();
  if (!current?.temporary || current.claim_handoff?.verifier !== state.verifier) return null;
  saveConfig({ ...current, claim_handoff: registered });
  return registered;
}

async function acknowledge(handoffId: string, verifier: string): Promise<boolean> {
  try {
    const { response, envelope } = await post<{ acknowledged: boolean }>('/auth/temp-handoff/ack', {
      handoff_id: handoffId,
      verifier,
    });
    return response.ok && envelope.ok && envelope.data?.acknowledged === true;
  } catch {
    return false;
  }
}

/** Remove only the acknowledgement we actually sent, from the config that is
 * current after the network wait. A concurrent login must win this race. */
function clearCurrentAcknowledgement(expected: ClaimCliHandoffAck): CliConfig | null {
  const current = loadConfig();
  if (!current) return null;
  if (
    current.claim_handoff_ack?.handoff_id !== expected.handoff_id
    || current.claim_handoff_ack.verifier !== expected.verifier
  ) return current;
  const { claim_handoff_ack: _removed, ...clean } = current;
  saveConfig(clean as CliConfig);
  return clean as CliConfig;
}

/** Remove the expired continuation only if the config still holds exactly it. */
function dropExpiredHandoff(token: string, state: ClaimCliHandoff): void {
  const current = loadConfig();
  if (
    !current?.temporary
    || current.token !== token
    || current.claim_handoff?.handoff_id !== state.handoff_id
    || current.claim_handoff?.verifier !== state.verifier
  ) return;
  const { claim_handoff: _expired, ...rest } = current;
  saveConfig(rest as CliConfig);
}

export async function recoverClaimHandoff(): Promise<ClaimHandoffRecovery> {
  let config = loadConfig();
  if (!config) return { kind: 'none' };

  if (config.claim_handoff_ack) {
    const ack = config.claim_handoff_ack;
    if (await acknowledge(ack.handoff_id, ack.verifier)) {
      config = clearCurrentAcknowledgement(ack);
      if (!config) return { kind: 'none' };
    }
  }

  const state = config.temporary ? config.claim_handoff : undefined;
  if (!state?.handoff_id) return { kind: 'none' };
  let response: HttpResponse;
  let envelope: Envelope<ExchangeResult>;
  try {
    ({ response, envelope } = await post<ExchangeResult>('/auth/temp-handoff/exchange', {
      handoff_id: state.handoff_id,
      verifier: state.verifier,
    }));
  } catch {
    return { kind: 'none' }; // Network trouble must not block a still-live temp session.
  }

  if (
    envelope.error === 'CLAIM_CLI_ACCOUNT_SCOPE_FORBIDDEN'
    || (envelope.data?.approved_scope !== undefined && envelope.data.approved_scope !== 'project')
  ) {
    return {
      kind: 'manual',
      message: `This claim approval cannot be used to sign in. Run \`${cliInvocation()} login\` and ask the account owner to approve it.`,
    };
  }

  if (!response.ok || !envelope.ok || !envelope.data) {
    if (['CLAIM_CLI_HANDOFF_PENDING', 'CLAIM_CLI_HANDOFF_IN_PROGRESS'].includes(envelope.error || '')) {
      return { kind: 'none' };
    }
    // The server says the continuation expired (terminal) and this machine's
    // temporary session is past its own expiry too: neither can be used again,
    // so an unrelated command (init, a deploy that starts fresh) must not stop
    // on it. Only that exact dead record is dropped.
    if (envelope.error === 'CLAIM_CLI_HANDOFF_EXPIRED' && temporaryConfigExpired(config)) {
      dropExpiredHandoff(config.token, state);
      return {
        kind: 'stale',
        message: `The temporary workspace on this machine expired at ${config.temp_expires_at}. If you claimed it in the browser, \`${cliInvocation()} login\` signs in to it.`,
      };
    }
    if (['CLAIM_CLI_HANDOFF_DENIED', 'CLAIM_CLI_HANDOFF_EXPIRED', 'CLAIM_CLI_HANDOFF_CONSUMED', 'CLAIM_CLI_HANDOFF_OWNERSHIP_MISMATCH'].includes(envelope.error || '')) {
      return {
        kind: 'manual',
        message: envelope.message || `Run \`${cliInvocation()} login\` in this directory. Keep the existing project link; do not unlink or redeploy.`,
      };
    }
    return { kind: 'none' };
  }

  const delivered = decodeCredentials(state, envelope.data);
  const current = loadConfig();
  if (
    !current?.temporary
    || current.token !== config.token
    || current.claim_handoff?.project_id !== state.project_id
    || current.claim_handoff.verifier !== state.verifier
    || current.claim_handoff.handoff_id !== state.handoff_id
  ) {
    return { kind: 'none' };
  }
  const next: CliConfig = {
    token: delivered.token,
    ...(delivered.credential_kind === 'project_agent'
      ? { claim_access: delivered.claim_access }
      : { refresh_token: delivered.refresh_token!, access_expires_at: delivered.expires_at }),
    user: { email: delivered.email, username: '' },
    claim_handoff_ack: { handoff_id: state.handoff_id, verifier: state.verifier },
  };
  // Save before acknowledging. If the process or response is lost, the server
  // keeps the same encrypted delivery retrievable and never mints a second key.
  saveConfig(next);
  if (await acknowledge(state.handoff_id, state.verifier)) {
    clearCurrentAcknowledgement(next.claim_handoff_ack!);
  }
  return {
    kind: 'recovered',
    message: delivered.claim_access === 'new_projects'
      ? 'Connected. You can work on the saved apps and create new apps in this account.'
      : delivered.claim_access === 'all_projects'
        ? 'Connected. You can work on the apps already in this account and create new ones.'
        : `Connected. You can work on the saved app. Run \`${cliInvocation()} login\` for account access.`,
  };
}
