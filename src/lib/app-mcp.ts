import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { API_BASE_URL } from './client.js';
import { cliConfigDir, writePrivateConfigFile } from './config.js';
import { fetchWithProxy } from './http.js';
import open from './open.js';

/**
 * A user of an app built on Somewhere signs in to that app from a terminal and
 * calls its MCP tools. The app's own OAuth server does the work:
 * the CLI is one more public client, registered once per app on this machine.
 *
 * Two principals never mix here: nothing in this file reads the developer
 * login (config.json), and the app user's tokens live in their own file and are
 * sent only to the app origin (access token) or the app's Somewhere issuer
 * (refresh token, revoke).
 */

export const CLIENT_NAME = 'Somewhere CLI (terminal)';
/** One fixed loopback port and one fixed fallback, both registered on the one client. */
export const CALLBACK_PORTS = [47623, 47624] as const;
const PROTOCOL_VERSION = '2025-06-18';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const STORE_DIR = 'app-mcp';
const STORE_FILE = 'tokens.json';
/** The store lock is held for at most one refresh or revoke (30 s request timeout). */
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 90_000;

export class AppMcpCliError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'AppMcpCliError';
  }
}

// ---------------------------------------------------------------- addresses

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The app's origin from what the user typed: `notes.somewhere.site`, `https://notes.somewhere.site/mcp`. */
export function appOrigin(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new AppMcpCliError(`"${input}" is not an app address. Give the app's URL, for example https://notes.somewhere.site.`, 'INVALID_APP_URL');
  }
  if (url.username || url.password) throw new AppMcpCliError('An app address cannot carry a user name or password.', 'INVALID_APP_URL');
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new AppMcpCliError(`${url.origin} is not https. Apps are signed in to over https only (http is allowed for 127.0.0.1 and localhost).`, 'INVALID_APP_URL');
  }
  return url.origin;
}

/**
 * Issuers this CLI sends a refresh token to: exactly <API base>/app-mcp/<project id>. The API
 * base is https://api.somewhere.cloud/v1 unless this shell sets SOMEWHERE_API_URL (local
 * tests); an app cannot change it.
 */
function issuerPrefix(): string {
  return `${API_BASE_URL}/app-mcp/`;
}

export function isSomewhereIssuer(issuer: string): boolean {
  const prefix = issuerPrefix();
  if (!issuer.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,128}$/.test(issuer.slice(prefix.length))) return false;
  try {
    const url = new URL(issuer);
    return url.href === issuer && !url.username && !url.password;
  } catch {
    return false;
  }
}

function assertIssuer(issuer: string, origin: string): void {
  if (!isSomewhereIssuer(issuer)) {
    throw new AppMcpCliError(`${origin} names ${issuer} as its sign-in server, which is not a Somewhere app sign-in server. Nothing was sent.`, 'ISSUER_REFUSED');
  }
}

function callbackUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

// ---------------------------------------------------------------- token store

export interface AppEntry {
  issuer: string;
  client_id: string;
  redirect_uris: string[];
  access_token?: string;
  refresh_token?: string;
  /** Epoch ms. */
  access_expires_at?: number;
}
interface Store { version: 1; apps: Record<string, AppEntry> }

export function storePath(): string {
  return join(cliConfigDir(), STORE_DIR, STORE_FILE);
}

function readStore(): Store {
  let body: string;
  try {
    body = readFileSync(storePath(), 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { version: 1, apps: {} };
    throw new AppMcpCliError(`This shell cannot read ${storePath()} (${code ?? String(err)}), where app sign-ins are kept.`, 'APP_STORE_UNREADABLE');
  }
  try {
    const parsed = JSON.parse(body) as Store;
    if (parsed && parsed.version === 1 && parsed.apps && typeof parsed.apps === 'object') return parsed;
  } catch { /* reported below */ }
  throw new AppMcpCliError(`${storePath()} is not a valid app sign-in file. Delete it and sign in to your apps again.`, 'APP_STORE_INVALID');
}

function writeStore(store: Store): void {
  writePrivateConfigFile(STORE_DIR, STORE_FILE, JSON.stringify(store, null, 2) + '\n');
}

/** Every token this process has held, so output can never show one (an app may echo it back). */
const heldTokens = new Set<string>();
function remember(entry: AppEntry | undefined): AppEntry | undefined {
  for (const token of [entry?.access_token, entry?.refresh_token]) if (token) heldTokens.add(token);
  return entry;
}

export function redactTokens(text: string): string {
  let out = text;
  for (const token of heldTokens) out = out.split(token).join('[redacted]');
  return out;
}

export function loadEntry(origin: string): AppEntry | undefined {
  return remember(readStore().apps[origin]);
}

let lockHeld = false;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One process at a time reads, changes and writes the store, and refreshes. Two commands
 * at once would otherwise both spend the same single-use refresh token, and the issuer
 * revokes the whole sign-in on the second use. The lock is a directory (mkdir is atomic);
 * one left by a process that died is taken over after LOCK_STALE_MS. Waiting is silent.
 */
async function withStoreLock<T>(work: () => Promise<T>): Promise<T> {
  if (lockHeld) return work();
  const dir = join(cliConfigDir(), STORE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lock = join(dir, 'tokens.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let age = 0;
    try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; /* released meanwhile */ }
    if (age > LOCK_STALE_MS) {
      try { rmdirSync(lock); } catch { /* another waiter took it over */ }
      continue;
    }
    if (Date.now() > deadline) {
      throw new AppMcpCliError(`Another somewhere app command has held ${lock} for ${Math.round(age / 1000)} s. If none is running, delete that folder and try again.`, 'APP_STORE_LOCKED');
    }
    await pause(20 + Math.random() * 30);
  }
  lockHeld = true;
  try {
    return await work();
  } finally {
    lockHeld = false;
    try { rmdirSync(lock); } catch { /* already gone */ }
  }
}

function saveEntry(origin: string, entry: AppEntry): Promise<void> {
  return withStoreLock(async () => {
    const store = readStore();
    store.apps[origin] = entry;
    writeStore(store);
  });
}

/** Forget the tokens of the sign-in that holds `token`; keep the registered client so the
 *  next sign-in reuses it. A newer sign-in stored by another process is left alone. */
function dropTokens(origin: string, token: string): Promise<void> {
  return withStoreLock(async () => {
    const store = readStore();
    const entry = store.apps[origin];
    if (!entry || (entry.access_token !== token && entry.refresh_token !== token)) return;
    store.apps[origin] = { issuer: entry.issuer, client_id: entry.client_id, redirect_uris: entry.redirect_uris };
    writeStore(store);
  });
}

// ---------------------------------------------------------------- HTTP

/**
 * Every request of this feature. No redirect is followed: a token goes only to
 * the URL it was addressed to, never on to wherever a response points.
 */
async function send(url: string, init: { method: string; headers?: Record<string, string>; body?: string }) {
  const response = await fetchWithProxy(url, { ...init, redirect: 'manual' }, 30_000);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? '';
    let where = location;
    try { where = new URL(location, url).origin; } catch { /* keep the raw value */ }
    throw new AppMcpCliError(`${new URL(url).origin} answered with a redirect to ${where || 'another address'}. It was not followed, so nothing was sent there.`, 'REDIRECT_REFUSED');
  }
  return response;
}

async function readJson(response: { text(): Promise<string> }): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return null; }
}

function errorCode(body: unknown): string | undefined {
  return body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : undefined;
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

// ---------------------------------------------------------------- discovery

/** One GET: the protected-resource document names the app's issuer. */
async function discover(origin: string): Promise<{ issuer: string; resource: string }> {
  const resource = `${origin}/mcp`;
  const noServer = new AppMcpCliError(
    `${origin} has no app MCP server: it declares no tools, or its owner turned app MCP off.`,
    'APP_MCP_ABSENT',
  );
  const response = await send(`${origin}/.well-known/oauth-protected-resource/mcp`, { method: 'GET', headers: { accept: 'application/json' } });
  if (!response.ok) throw noServer;
  const body = await readJson(response) as { resource?: unknown; authorization_servers?: unknown } | null;
  const issuer = Array.isArray(body?.authorization_servers) ? body.authorization_servers[0] : undefined;
  if (!body || body.resource !== resource || typeof issuer !== 'string') throw noServer;
  assertIssuer(issuer, origin);
  return { issuer, resource };
}

// ---------------------------------------------------------------- browser

/** Why a browser cannot be opened here, before anything is sent. */
export function browserUnavailable(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  if (env.SOMEWHERE_NO_BROWSER) return null; // The user opens the printed address themselves.
  if (env.SSH_CONNECTION || env.SSH_TTY) return 'this shell is an SSH session, so a browser would open on the other computer, not yours';
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return 'this shell has no display to open a browser on';
  return null;
}

const NO_BROWSER_HINT = 'somewhere app login needs a browser on this computer. Signing in over SSH, in a container or in a headless shell is not supported.';

function listen(port: number): Promise<http.Server | null> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') resolve(null);
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function bindCallback(): Promise<{ server: http.Server; redirectUri: string }> {
  for (const port of CALLBACK_PORTS) {
    const server = await listen(port);
    if (server) return { server, redirectUri: callbackUri(port) };
  }
  throw new AppMcpCliError(
    `Ports ${CALLBACK_PORTS.join(' and ')} on 127.0.0.1 are both in use, and sign-in needs one of them to receive the browser's answer. Close whatever is using them and try again.`,
    'CALLBACK_PORTS_IN_USE',
  );
}

const page = (title: string, text: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body></html>`;

/** Wait for the one redirect that carries this sign-in's state; anything else is ignored. */
function awaitCallback(server: http.Server, state: string, issuer: string): { done: Promise<string>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AppMcpCliError('Sign-in was not finished in the browser within 5 minutes. Run the command again.', 'LOGIN_TIMED_OUT'));
    }, LOGIN_TIMEOUT_MS);
    server.on('request', (req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1');
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, title: string, text: string, outcome: () => void) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page(title, text));
        clearTimeout(timer);
        server.close(); // The one answer arrived: stop listening before the token exchange.
        outcome();
      };
      const iss = url.searchParams.get('iss');
      if (iss !== null && iss !== issuer) {
        finish(400, 'Sign-in refused', 'The answer came from a different sign-in server. Return to your terminal.', () =>
          reject(new AppMcpCliError(`The browser's answer came from ${iss}, not ${issuer}. Nothing was stored.`, 'ISSUER_MISMATCH')));
        return;
      }
      const failure = url.searchParams.get('error');
      if (failure) {
        finish(200, 'Access not granted', 'Nothing was connected. Return to your terminal.', () =>
          reject(failure === 'access_denied'
            ? new AppMcpCliError('Access was refused on the consent page, so nothing was stored.', 'CONSENT_REFUSED')
            : new AppMcpCliError(`The app's sign-in server refused the request (${failure}). Nothing was stored.`, 'AUTHORIZE_REFUSED')));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        finish(400, 'Sign-in failed', 'The answer carried no code. Return to your terminal.', () =>
          reject(new AppMcpCliError('The browser returned without an authorization code. Nothing was stored.', 'AUTHORIZE_REFUSED')));
        return;
      }
      finish(200, 'Signed in', 'You can close this tab and return to your terminal.', () => resolve(code));
    });
  });
  done.catch(() => { /* awaited by the caller; never an unhandled rejection if login stops early */ });
  return { done, cancel: () => clearTimeout(timer) };
}

// ---------------------------------------------------------------- sign-in

const base64url = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function storeTokens(origin: string, entry: AppEntry, body: unknown): Promise<AppEntry> {
  const tokens = body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null;
  if (typeof tokens?.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
    throw new AppMcpCliError('The sign-in server answered without tokens. Nothing was stored.', 'TOKEN_RESPONSE_INVALID');
  }
  const expiresIn = typeof tokens.expires_in === 'number' && tokens.expires_in > 0 ? tokens.expires_in : 3600;
  const next: AppEntry = {
    issuer: entry.issuer,
    client_id: entry.client_id,
    redirect_uris: entry.redirect_uris,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    access_expires_at: Date.now() + expiresIn * 1000,
  };
  remember(next);
  await saveEntry(origin, next);
  return next;
}

export interface LoginResult { origin: string; clientReused: boolean }

export async function appLogin(
  input: string,
  log: (line: string) => void,
): Promise<LoginResult> {
  const origin = appOrigin(input);
  const noBrowser = browserUnavailable();
  if (noBrowser) throw new AppMcpCliError(`Cannot sign in here: ${noBrowser}. ${NO_BROWSER_HINT}`, 'NO_BROWSER');

  const { issuer, resource } = await discover(origin);
  const { server, redirectUri } = await bindCallback();
  let callback: ReturnType<typeof awaitCallback> | undefined;
  try {
    const redirectUris = CALLBACK_PORTS.map(callbackUri);
    let entry = loadEntry(origin);
    const clientReused = Boolean(entry && entry.issuer === issuer && entry.client_id
      && JSON.stringify(entry.redirect_uris) === JSON.stringify(redirectUris));
    if (!clientReused || !entry) {
      const response = await send(`${issuer}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: CLIENT_NAME,
          redirect_uris: redirectUris,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      });
      const body = await readJson(response) as { client_id?: unknown } | null;
      if (!response.ok || typeof body?.client_id !== 'string') {
        throw new AppMcpCliError(`${origin} would not register this terminal as a client (HTTP ${response.status}${errorCode(body) ? `, ${errorCode(body)}` : ''}).`, 'REGISTER_REFUSED');
      }
      entry = { issuer, client_id: body.client_id, redirect_uris: redirectUris };
      // Kept at once: a sign-in abandoned in the browser still reuses this client next time.
      await saveEntry(origin, entry);
    }

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(24));
    const authorize = new URL(`${issuer}/authorize`);
    authorize.search = form({
      response_type: 'code',
      client_id: entry.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope: 'app:tools',
      resource,
    });

    callback = awaitCallback(server, state, issuer);
    log(`Opening your browser to sign in to ${origin}.`);
    log(`If it does not open, visit this address on this computer:`);
    log(authorize.toString());
    if (!process.env.SOMEWHERE_NO_BROWSER) {
      try {
        await open(authorize.toString());
      } catch (err) {
        throw new AppMcpCliError(`No browser could be opened (${err instanceof Error ? err.message : String(err)}). ${NO_BROWSER_HINT}`, 'NO_BROWSER');
      }
    }
    const code = await callback.done;

    const response = await send(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: entry.client_id, resource }),
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw new AppMcpCliError(`The sign-in server would not exchange the code (HTTP ${response.status}${errorCode(body) ? `, ${errorCode(body)}` : ''}). Nothing was stored; run the command again.`, 'TOKEN_REFUSED');
    }
    await storeTokens(origin, entry, body);
    return { origin, clientReused };
  } finally {
    callback?.cancel();
    server.close();
    server.closeAllConnections();
  }
}

// ---------------------------------------------------------------- calls

function signInAgain(origin: string): AppMcpCliError {
  return new AppMcpCliError(
    `Your sign-in to ${origin} has ended: you signed out of the app in the browser, it expired, or it was revoked. Sign in again with somewhere app login ${origin}`,
    'APP_SIGNIN_ENDED',
  );
}

/**
 * Renew the sign-in that `stale` holds: one POST /token, under the store lock. Another
 * process may have renewed it while this one waited; then its result is used and nothing is
 * sent, because a refresh token works once and a second use revokes the whole sign-in.
 */
async function refresh(origin: string, stale: AppEntry): Promise<AppEntry> {
  return withStoreLock(async () => {
    const current = loadEntry(origin);
    if (!current?.refresh_token) throw signInAgain(origin);
    if (current.access_token && current.access_token !== stale.access_token && (current.access_expires_at ?? 0) > Date.now() + 30_000) {
      return current;
    }
    assertIssuer(current.issuer, origin);
    const response = await send(`${current.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form({ grant_type: 'refresh_token', refresh_token: current.refresh_token, client_id: current.client_id, resource: `${origin}/mcp` }),
    });
    const body = await readJson(response);
    if (response.status === 400 || response.status === 401) {
      await dropTokens(origin, current.refresh_token);
      throw signInAgain(origin);
    }
    if (!response.ok) {
      throw new AppMcpCliError(`Could not renew the sign-in to ${origin} (HTTP ${response.status}${errorCode(body) ? `, ${errorCode(body)}` : ''}). Try again shortly.`, 'REFRESH_FAILED');
    }
    return storeTokens(origin, current, body);
  });
}

interface RpcResult { result?: unknown; error?: { code?: number; message?: string } }

/**
 * One JSON-RPC request is one POST to <app>/mcp: the app MCP transport keeps no
 * session, so there is no initialize. An access token past its expiry is
 * refreshed first; a 401 refreshes once and retries once.
 */
async function rpc(origin: string, method: string, params: Record<string, unknown>): Promise<RpcResult> {
  let entry = loadEntry(origin);
  if (!entry?.access_token) {
    throw new AppMcpCliError(`Not signed in to ${origin}. Run somewhere app login ${origin}`, 'APP_NOT_SIGNED_IN');
  }
  let refreshed = false;
  if ((entry.access_expires_at ?? 0) <= Date.now() + 30_000) {
    entry = await refresh(origin, entry);
    refreshed = true;
  }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  for (;;) {
    const response = await send(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${entry.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
      body,
    });
    if (response.status === 401) {
      await response.text();
      if (refreshed) {
        await dropTokens(origin, entry.access_token!);
        throw signInAgain(origin);
      }
      entry = await refresh(origin, entry);
      refreshed = true;
      continue;
    }
    const parsed = await readJson(response) as RpcResult | null;
    if (!response.ok || !parsed || typeof parsed !== 'object') {
      const code = errorCode(parsed);
      if (code === 'app_changed') {
        throw new AppMcpCliError(`${origin} published a new version as the call arrived, so the tool did not run. Run the command again.`, 'APP_CHANGED');
      }
      if (response.status === 404 || response.status === 405) {
        throw new AppMcpCliError(`${origin} has no app MCP server: it declares no tools, or its owner turned app MCP off.`, 'APP_MCP_ABSENT');
      }
      throw new AppMcpCliError(`${origin}/mcp answered HTTP ${response.status}${code ? ` (${code})` : ''}.`, 'APP_MCP_HTTP_ERROR');
    }
    return parsed;
  }
}

export interface AppTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { type?: unknown; description?: unknown }>; required?: string[] };
}

export async function listTools(input: string): Promise<AppTool[]> {
  const origin = appOrigin(input);
  const reply = await rpc(origin, 'tools/list', {});
  if (reply.error) throw new AppMcpCliError(`${origin} refused tools/list: ${reply.error.message ?? reply.error.code}.`, 'APP_MCP_RPC_ERROR');
  const tools = (reply.result as { tools?: unknown } | undefined)?.tools;
  return Array.isArray(tools) ? tools as AppTool[] : [];
}

/** `count (number, required), note (string)` from a tool's input schema. */
export function inputShape(tool: AppTool): string {
  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const parts = Object.entries(properties).map(([name, schema]) => {
    const type = typeof schema?.type === 'string' ? schema.type : Array.isArray(schema?.type) ? schema.type.join('|') : 'any';
    return `${name} (${type}${required.has(name) ? ', required' : ''})`;
  });
  return parts.length ? parts.join(', ') : 'no arguments';
}

export interface CallOutcome { result: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; isError?: boolean } }

export async function callTool(input: string, name: string, args: Record<string, unknown>): Promise<CallOutcome> {
  const origin = appOrigin(input);
  const reply = await rpc(origin, 'tools/call', { name, arguments: args });
  if (reply.error) {
    if (reply.error.code === -32602) {
      // Only on this failure: one more call, to name the tools there are.
      const tools = await listTools(origin);
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        const names = tools.map((candidate) => candidate.name).join(', ') || 'none';
        throw new AppMcpCliError(`${origin} has no tool named "${name}" for your sign-in. Tools: ${names}. A tool the app changed since you approved it needs a new sign-in: somewhere app login ${origin}`, 'TOOL_NOT_FOUND');
      }
      throw new AppMcpCliError(`${reply.error.message ?? 'The arguments were refused.'} ${name} takes: ${inputShape(tool)}.`, 'TOOL_ARGUMENTS_REFUSED');
    }
    throw new AppMcpCliError(`${origin} refused the call: ${reply.error.message ?? reply.error.code}.`, 'APP_MCP_RPC_ERROR');
  }
  return { result: (reply.result ?? {}) as CallOutcome['result'] };
}

// ---------------------------------------------------------------- sign-out

export interface LogoutResult { origin: string; signedIn: boolean; revoked: boolean; revokeProblem?: string }

/** Revoke at the issuer, then remove the local tokens whatever the issuer said. */
export async function appLogout(input: string): Promise<LogoutResult> {
  const origin = appOrigin(input);
  return withStoreLock(async () => {
    const entry = loadEntry(origin);
    const token = entry?.refresh_token ?? entry?.access_token;
    if (!entry || !token) return { origin, signedIn: false, revoked: false };
    let revokeProblem: string | undefined;
    try {
      assertIssuer(entry.issuer, origin);
      const response = await send(`${entry.issuer}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ token, client_id: entry.client_id }),
      });
      await response.text();
      if (!response.ok) revokeProblem = `HTTP ${response.status}`;
    } catch (err) {
      revokeProblem = err instanceof Error ? err.message : String(err);
    }
    await dropTokens(origin, token);
    return { origin, signedIn: true, revoked: !revokeProblem, ...(revokeProblem ? { revokeProblem } : {}) };
  });
}
