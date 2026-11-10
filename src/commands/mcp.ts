import { fetchWithProxy as fetch } from '../lib/http.js';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
// The @modelcontextprotocol/sdk value imports (transports, UnauthorizedError)
// are LAZY — loaded inside runStdioBridge only. They pull in a large tree
// (zod/hono/ajv), and this module is registered at startup for EVERY command,
// so a top-level import would make `somewhere deploy`/`run` pay for the MCP
// bridge they never use. Types are erased at compile, so they stay static.
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CURSOR_MCP_PATH,
  hasCursorMcpConfig,
  hasGlobalMcpConfig,
  loadConfig,
  saveCursorMcpConfig,
  saveGlobalMcpConfig,
  cliConfigPathForDisplay,
  somewhereStdioEntry,
} from '../lib/config.js';
import { ApiClient, CliApiError, typedServerError } from '../lib/client.js';
import { CLI_VERSION } from '../lib/version.js';
import { dim, error, info, success, teal } from '../lib/output.js';
import {
  createPlatformMcpTransport,
  isMcpAuthRejection,
  mcpAccessExpiresSoon,
  describeMcpFailure,
  mcpHttpFailure,
  refreshMcpAccessToken,
} from '../lib/platform-tools.js';

const UPSTREAM_URL =
  process.env.SOMEWHERE_MCP_URL?.replace(/\/$/, '') || 'https://mcp.somewhere.cloud/mcp';

const INSTALL_HOSTS = ['codex', 'claude-code', 'cursor'] as const;
type InstallHost = (typeof INSTALL_HOSTS)[number];

const RESTART_HINT =
  'MCP hosts load tools when a session starts. Open a NEW session (or restart the host), then look for tools named mcp__somewhere__*.';

// Emit a JSON-RPC error notification on stdout so MCP hosts surface a clear
// message instead of a generic crash. id=null because it's not a response to
// any specific request.
function emitFatalError(message: string): void {
  const payload = {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32001, message },
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

export function registerMcp(program: Command) {
  const mcp = program
    .command('mcp')
    .description('Run somewhere.cloud MCP server over stdio (proxies to mcp.somewhere.cloud)')
    .action(runStdioBridge);

  // Hidden alias: docs/llms-full.md taught `somewhere mcp stdio` — keep it
  // true rather than breaking copies already cached in agents and scrapes.
  mcp
    .command('stdio', { hidden: true })
    .description('Alias of bare `somewhere mcp`')
    .action(runStdioBridge);

  mcp
    .command('install <host>')
    .description(`Configure an MCP host to use somewhere.cloud (${INSTALL_HOSTS.join(', ')})`)
    .action(runInstall);

  mcp
    .command('doctor')
    .description('Check MCP setup: login, token validity, server reachability, host configs')
    .action(async () => {
      await runDoctor(program.version() ?? 'unknown');
    });
}

/* ─── stdio bridge (bare `somewhere mcp`) ─────────────────────────── */

/** The one tool the bridge serves itself while it cannot reach Somewhere. */
export const BRIDGE_STATUS_TOOL = 'somewhere_status';

/** Why the bridge is serving locally, and the login it last tried (never printed). */
interface Recovery {
  kind: 'login' | 'update';
  code: string;
  message: string;
  token: string | null;
  lastAttempt?: string;
}

type RpcId = string | number;
type RpcMessage = { jsonrpc: '2.0'; id?: RpcId | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

const NOT_SENT = 'Nothing was sent to Somewhere for this call, and the bridge will not send it later.';

/** A refusal the user fixes outside the bridge (log in, update the CLI); null for anything else. */
function recoverableReason(err: unknown): Omit<Recovery, 'token'> | null {
  const typed = typedServerError(err);
  if (typed?.code === 'CLIENT_UPDATE_REQUIRED' || (typed && (typed.status === 410 || typed.status === 426))) {
    return { kind: 'update', code: typed.code, message: typed.message };
  }
  if (typed?.status === 401) return { kind: 'login', code: typed.code, message: typed.message };
  const http = mcpHttpFailure(err);
  if (http && (http.code === 'CLIENT_UPDATE_REQUIRED' || http.status === 410 || http.status === 426)) {
    return { kind: 'update', code: http.code ?? 'CLIENT_UPDATE_REQUIRED', message: http.message };
  }
  if (http?.status === 401 || isMcpAuthRejection(err)) {
    return { kind: 'login', code: http?.code ?? 'LOGIN_REJECTED', message: `Somewhere refused this login (HTTP 401)${http && http.message ? `: ${http.message}` : '.'}` };
  }
  return null;
}

function recoveryText(recovery: Recovery): string {
  const next = recovery.kind === 'update'
    ? 'After updating, restart this MCP session so it runs the new CLI.'
    : `Run \`somewhere login\` in a terminal, then call ${BRIDGE_STATUS_TOOL} again: the bridge picks up the new login without a restart.`;
  return `Somewhere is not connected. ${recovery.code}: ${recovery.message} ${next}`
    + (recovery.lastAttempt ? ` Last connection attempt: ${recovery.lastAttempt}` : '');
}

async function runStdioBridge(): Promise<void> {
  // Lazy-load the SDK only when the bridge actually runs (see import note above).
  const [{ StdioServerTransport }, { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);

  const stdioTransport = new StdioServerTransport();
  const log = (line: string) => process.stderr.write(`[somewhere mcp] ${line}\n`);
  const toHost = (message: RpcMessage): void => {
    stdioTransport.send(message as JSONRPCMessage).catch((err: unknown) => log(`stdio send failed: ${String(err)}`));
  };

  let shuttingDown = false;
  let refreshInFlight: Promise<void> | null = null;
  let leaveInFlight: Promise<boolean> | null = null;
  let httpTransport: StreamableHTTPClientTransport | null = null;
  let hostInitialized = false;
  let probeSeq = 0;
  /** Forwarded `initialize` requests: their answers declare tools.listChanged, which this bridge delivers. */
  const initializeIds = new Set<RpcId>();
  /** The bridge's own read-only probes; their answers never reach the host. */
  const probes = new Map<RpcId, (message: RpcMessage) => void>();

  const initialToken = loadConfig()?.token ?? null;
  let recovery: Recovery | null = initialToken
    ? null
    : { kind: 'login', code: 'NOT_LOGGED_IN', message: 'This machine has no Somewhere login.', token: null };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await stdioTransport.close(); } catch {}
    try { await httpTransport?.close(); } catch {}
  };

  const bindHttpTransport = (transport: StreamableHTTPClientTransport): void => {
    transport.onmessage = (msg: JSONRPCMessage) => {
      const message = msg as RpcMessage;
      if (message.id !== undefined && message.id !== null && probes.has(message.id)) {
        probes.get(message.id)!(message);
        return;
      }
      if (message.id !== undefined && message.id !== null && initializeIds.delete(message.id) && message.result && typeof message.result === 'object') {
        const result = message.result as { capabilities?: { tools?: Record<string, unknown> } };
        result.capabilities = { ...result.capabilities, tools: { ...result.capabilities?.tools, listChanged: true } };
      }
      toHost(message);
    };
    transport.onclose = () => {
      // Closing a superseded transport is part of a refresh or of entering recovery.
      if (transport === httpTransport) void shutdown();
    };
    transport.onerror = (err) => {
      // send() reports this same error to its caller, which owns the handling.
      if (isMcpAuthRejection(err)) return;
      log(`upstream error: ${describeMcpFailure(err)}`);
    };
  };

  const createHttpTransport = async (token: string): Promise<StreamableHTTPClientTransport> => {
    const transport = await createPlatformMcpTransport(token);
    bindHttpTransport(transport);
    await transport.start();
    return transport;
  };

  const notifyToolsChanged = (): void => {
    if (hostInitialized) toHost({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  };

  const enterRecovery = (reason: Omit<Recovery, 'token'>, token: string | null): void => {
    const wasUpstream = recovery === null;
    recovery = { ...reason, token };
    const previous = httpTransport;
    httpTransport = null;
    void previous?.close().catch(() => {});
    log(`not connected (${reason.code}); serving ${BRIDGE_STATUS_TOOL} until it is fixed`);
    if (wasUpstream) notifyToolsChanged();
  };

  const reply = (id: RpcId, result: unknown): void => toHost({ jsonrpc: '2.0', id, result });
  const replyError = (id: RpcId, code: number, message: string): void =>
    toHost({ jsonrpc: '2.0', id, error: { code, message } });

  /** Reconnect with a login made outside the bridge, proved by a read-only tools/list. Never replays anything. */
  const tryLeaveRecovery = (): Promise<boolean> => {
    if (leaveInFlight) return leaveInFlight;
    leaveInFlight = (async () => {
      const current = recovery;
      if (!current) return true;
      const token = loadConfig()?.token ?? null;
      if (!token || token === current.token) return false;
      let transport: StreamableHTTPClientTransport | null = null;
      try {
        transport = await createHttpTransport(token);
        const id = `somewhere-bridge-probe-${++probeSeq}`;
        const answered = new Promise<RpcMessage>((resolve, reject) => {
          const timer = setTimeout(() => { probes.delete(id); reject(new Error('no answer to tools/list within 15s')); }, 15_000);
          probes.set(id, (message) => { clearTimeout(timer); probes.delete(id); resolve(message); });
        });
        await transport.send({ jsonrpc: '2.0', id, method: 'tools/list', params: {} } as JSONRPCMessage);
        const answer = await answered;
        if (answer.error) throw new Error(`tools/list was refused: ${JSON.stringify(answer.error).slice(0, 300)}`);
      } catch (err) {
        void transport?.close().catch(() => {});
        const reason = recoverableReason(err);
        recovery = reason ? { ...reason, token } : { ...current, lastAttempt: describeMcpFailure(err) };
        return false;
      }
      httpTransport = transport;
      recovery = null;
      log('connected with the current login');
      notifyToolsChanged();
      return true;
    })();
    return leaveInFlight.finally(() => { leaveInFlight = null; });
  };

  const renewHttpTransport = async (preemptive = false): Promise<void> => {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      // Reuse the CLI's canonical renewal path: refresh after the
      // API confirms API_KEY_EXPIRED, or just before the server-provided access
      // expiry. Both paths rotate and persist the replacement smtr_ pair.
      const renewedToken = await refreshMcpAccessToken(preemptive);
      const previous = httpTransport;
      httpTransport = await createHttpTransport(renewedToken);
      await previous?.close();
    })();
    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  };

  /** Answer a host request while disconnected: initialize, the one status tool, and actionable errors. */
  const answerLocally = (message: RpcMessage, state: Recovery, unsentNote = false): void => {
    if (message.id === undefined || message.id === null || !message.method) return;
    const id = message.id;
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        reply(id, {
          protocolVersion: typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'somewhere', version: CLI_VERSION },
          instructions: `${recoveryText(state)} Until then the only tool is ${BRIDGE_STATUS_TOOL}.`,
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, {
          tools: [{
            name: BRIDGE_STATUS_TOOL,
            description: 'Somewhere is not connected in this session. Call this to see why and what fixes it; after `somewhere login` it reconnects and the full tool list returns.',
            inputSchema: { type: 'object', properties: {} },
          }],
        });
        return;
      case 'tools/call': {
        const name = message.params?.name;
        const other = name !== BRIDGE_STATUS_TOOL;
        reply(id, {
          content: [{ type: 'text', text: `${recoveryText(state)}${other || unsentNote ? ` ${NOT_SENT}` : ''}` }],
          isError: true,
        });
        return;
      }
      default:
        replyError(id, -32601, `${message.method} is unavailable: ${recoveryText(state)}`);
    }
  };

  const forwardUpstream = async (message: RpcMessage): Promise<void> => {
    const isRequest = message.id !== undefined && message.id !== null && typeof message.method === 'string';
    const usedToken = loadConfig()?.token ?? null;
    if (!usedToken) {
      // Logged out while the session runs: the renewal path would otherwise exit the process.
      enterRecovery({ kind: 'login', code: 'NOT_LOGGED_IN', message: 'This machine has no Somewhere login.' }, null);
      if (isRequest) answerLocally(message, recovery!, true);
      return;
    }
    try {
      // New login configs carry the exact access expiry. Renew before forwarding
      // so a mutating MCP request is never replayed merely because it crossed
      // the 24-hour auth boundary. Older configs retain the 401 fallback below.
      if (mcpAccessExpiresSoon()) await renewHttpTransport(true);
      // Only after the bridge closed the transport for a logout seen mid-session.
      if (!httpTransport) httpTransport = await createHttpTransport(usedToken);
      if (isRequest && message.method === 'initialize') initializeIds.add(message.id!);
      try {
        await httpTransport.send(message as JSONRPCMessage);
        return;
      } catch (err) {
        if (!isMcpAuthRejection(err)) throw err;
      }
      // A 401 means the platform did not run the request. Renew the expired key and
      // send it exactly once more; a second refusal is a login problem, never a loop.
      await renewHttpTransport();
      await httpTransport!.send(message as JSONRPCMessage);
    } catch (err) {
      if (isRequest && message.method === 'initialize') initializeIds.delete(message.id!);
      const reason = recoverableReason(err);
      if (reason) enterRecovery(reason, usedToken);
      if (recovery) {
        if (isRequest) answerLocally(message, recovery, true);
        return;
      }
      // Not a login or version problem: report the real reason and keep serving.
      const detail = describeMcpFailure(err);
      if (isRequest) replyError(message.id!, -32603, `${detail} The bridge is still running; retry when Somewhere is reachable.`);
      else log(`could not forward ${message.method ?? 'a response'}: ${detail}`);
    }
  };

  const handleHostMessage = async (message: RpcMessage): Promise<void> => {
    if (message.method === 'notifications/initialized') hostInitialized = true;
    if (!recovery) return forwardUpstream(message);
    const isRequest = message.id !== undefined && message.id !== null && typeof message.method === 'string';
    if (!isRequest) return; // notifications and responses have nowhere to go while disconnected
    if (await tryLeaveRecovery()) {
      if (message.method === 'tools/call' && message.params?.name === BRIDGE_STATUS_TOOL) {
        reply(message.id!, { content: [{ type: 'text', text: 'Somewhere is connected with the current login. The full tool list is available again (your MCP client was told it changed; list tools to see it).' }] });
        return;
      }
      return forwardUpstream(message);
    }
    answerLocally(message, recovery!);
  };

  stdioTransport.onmessage = (msg: JSONRPCMessage) => {
    handleHostMessage(msg as RpcMessage).catch((err: unknown) => log(`unexpected bridge error: ${describeMcpFailure(err)}`));
  };
  stdioTransport.onclose = () => { void shutdown(); };
  stdioTransport.onerror = (err) => { log(`stdio error: ${String(err)}`); };

  if (recovery) log(`not connected (${recovery.code}); serving ${BRIDGE_STATUS_TOOL} until it is fixed`);
  // One upstream transport before any host message, so concurrent first requests share it.
  else httpTransport = await createHttpTransport(initialToken!);
  try {
    await stdioTransport.start();
  } catch (err) {
    emitFatalError(`Failed to start stdio transport: ${String(err)}`);
    process.exit(1);
  }
}

/* ─── somewhere mcp install <host> ────────────────────────────────── */

function runInstall(host: string): void {
  if (!(INSTALL_HOSTS as readonly string[]).includes(host)) {
    error(`Unknown host "${host}". Supported: ${INSTALL_HOSTS.join(', ')}`);
    process.exit(1);
  }
  const loggedIn = !!loadConfig()?.token;
  switch (host as InstallHost) {
    case 'codex': installCodex(loggedIn); break;
    case 'claude-code': installClaudeCode(); break;
    case 'cursor': installCursor(loggedIn); break;
  }
}

// Windows: the `codex` CLI installs as codex.cmd. spawnSync without a shell does
// no PATHEXT resolution (won't find the .cmd) and .cmd needs a shell anyway since
// CVE-2024-27980 — so probes silently reported "not found" on win32. Shell on
// win32 only; args are static identifiers, no injection surface.
const CODEX_SHELL = process.platform === 'win32';

/** Codex owns its own config format, so we drive its CLI instead of writing
 *  the file ourselves. The entry uses the stdio bridge so auth rides the
 *  CLI login rather than a token pasted into Codex config. */
/** Carry SOMEWHERE_CONFIG_DIR into the Codex entry, like the JSON hosts. */
function codexEnvArgs(): string[] {
  const env = somewhereStdioEntry().env;
  return env ? ['--env', `SOMEWHERE_CONFIG_DIR=${env.SOMEWHERE_CONFIG_DIR}`] : [];
}

function installCodex(loggedIn: boolean): void {
  const probe = spawnSync('codex', ['--version'], { stdio: 'ignore', shell: CODEX_SHELL });
  if (probe.error || probe.status !== 0) {
    error('Codex CLI not found on PATH.');
    info('Install Codex first, then either re-run this command or add the entry manually:');
    info(dim(`  codex mcp add somewhere ${codexEnvArgs().join(' ')}${codexEnvArgs().length ? ' ' : ''}-- somewhere mcp`));
    process.exit(1);
  }

  const existing = spawnSync('codex', ['mcp', 'get', 'somewhere'], { stdio: 'ignore', shell: CODEX_SHELL });
  if (existing.status === 0) {
    success('Codex already has a "somewhere" MCP server configured.');
    info(dim('To reconfigure: codex mcp remove somewhere, then re-run this command.'));
  } else {
    const add = spawnSync('codex', ['mcp', 'add', 'somewhere', ...codexEnvArgs(), '--', 'somewhere', 'mcp'], { stdio: 'inherit', shell: CODEX_SHELL });
    if (add.status !== 0) {
      error('`codex mcp add` failed (see output above).');
      process.exit(1);
    }
    success(`Codex configured: ${teal('somewhere')} → somewhere mcp (stdio bridge)`);
  }

  if (!loggedIn) info(`Not logged in yet — run: ${teal('somewhere login')}`);
  printVerify('codex');
}

function installClaudeCode(): void {
  const loggedIn = !!loadConfig()?.token;
  // Write the stdio bridge, NOT a baked token. The bridge reads
  // ~/.somewhere/config.json at every launch, so a re-login never leaves a
  // stale token behind in Claude Code's config (tsk_104fe2d0). This matches
  // Cursor (saveCursorMcpConfig) and Codex (installCodex).
  saveGlobalMcpConfig();
  success(`Claude Code configured (~/.claude.json): ${teal('somewhere')} → somewhere mcp (stdio bridge)`);
  if (!loggedIn) info(`Not logged in yet — run: ${teal('somewhere login')}`);
  printVerify('claude-code');
}

function installCursor(loggedIn: boolean): void {
  saveCursorMcpConfig();
  success(`Cursor configured (${CURSOR_MCP_PATH}): ${teal('somewhere')} → somewhere mcp (stdio bridge)`);
  if (!loggedIn) info(`Not logged in yet — run: ${teal('somewhere login')}`);
  printVerify('cursor');
}

function printVerify(host: InstallHost): void {
  info('');
  switch (host) {
    case 'codex':
      info(`Verify: ${teal('codex mcp list')} should show "somewhere".`);
      break;
    case 'claude-code':
      info(`Verify: run ${teal('/mcp')} inside Claude Code — "somewhere" should be listed.`);
      break;
    case 'cursor':
      info('Verify: Cursor Settings → MCP should list "somewhere".');
      break;
  }
  info(RESTART_HINT);
  info(dim('Full setup check: somewhere mcp doctor'));
}

/* ─── somewhere mcp doctor ────────────────────────────────────────── */

async function runDoctor(version: string): Promise<void> {
  let failures = 0;
  const fail = (msg: string, fix?: string) => {
    failures++;
    error(msg);
    if (fix) info(dim(`fix: ${fix}`));
  };

  info(`somewhere CLI ${version}`);
  info('');

  // 1. Login config present
  const config = loadConfig();
  if (config?.token) {
    success(`Logged in as ${teal(config.user.email || '(unknown)')} (${cliConfigPathForDisplay()})`);
  } else {
    fail(`Not logged in — no token in ${cliConfigPathForDisplay()}.`, 'somewhere login');
  }

  // 2. Token actually valid against the API. /auth/whoami is the endpoint
  // that accepts smt_ keys (verified 2026-06-09: /auth/platform-me rejects
  // a key that whoami and the MCP server both accept).
  if (config?.token) {
    try {
      const me = await new ApiClient(config.token).call<{ user?: { email?: string } }>('GET', '/auth/whoami');
      success(`Token valid (${me.user?.email ?? config.user.email ?? 'unknown account'})`);
    } catch (err) {
      // The platform's typed refusal says what is wrong; only an untyped 401 is a guess at the login.
      const typed = typedServerError(err);
      if (typed) fail(`Token check refused: ${typed.code}: ${typed.message}`);
      else if (err instanceof CliApiError && err.statusCode === 401) fail('Token rejected by the platform (HTTP 401).', 'somewhere login');
      else fail(`Could not check the token: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. MCP server reachability — a real initialize round-trip, not a ping.
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (config?.token) headers.Authorization = `Bearer ${config.token}`;
    const res = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'somewhere-mcp-doctor', version },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      success('MCP server reachable — initialize accepted (mcp.somewhere.cloud)');
    } else if (res.status === 401 && !config?.token) {
      success('MCP server reachable (responded 401 — expected without a login)');
    } else if (res.status === 401) {
      fail('MCP server reachable but it rejected the token.', 'somewhere login');
    } else {
      // Same parsing as the bridge, so the platform's code and message are printed.
      const text = await res.text().catch(() => '');
      fail(describeMcpFailure(Object.assign(new Error(`Streamable HTTP error: Error POSTing to endpoint: ${text}`), { code: res.status }), UPSTREAM_URL));
    }
  } catch (err) {
    fail(describeMcpFailure(err, UPSTREAM_URL));
  }

  // 4. Host configs — informational, not failures: not everyone uses every host.
  info('');
  info('Host configs:');
  if (hasGlobalMcpConfig()) {
    success('Claude Code: "somewhere" entry in ~/.claude.json');
  } else {
    info(dim('Claude Code: not configured — somewhere mcp install claude-code (or just somewhere login)'));
  }
  const codexProbe = spawnSync('codex', ['--version'], { stdio: 'ignore', shell: CODEX_SHELL });
  if (codexProbe.error || codexProbe.status !== 0) {
    info(dim('Codex: CLI not found on PATH — skipped'));
  } else if (spawnSync('codex', ['mcp', 'get', 'somewhere'], { stdio: 'ignore', shell: CODEX_SHELL }).status === 0) {
    success('Codex: "somewhere" MCP server configured');
  } else {
    info(dim('Codex: not configured — somewhere mcp install codex'));
  }
  if (hasCursorMcpConfig()) {
    success(`Cursor: "somewhere" entry in ${CURSOR_MCP_PATH}`);
  } else {
    info(dim('Cursor: not configured — somewhere mcp install cursor'));
  }

  info('');
  info(RESTART_HINT);
  process.exit(failures > 0 ? 1 : 0);
}
