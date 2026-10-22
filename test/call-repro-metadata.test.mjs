// `somewhere call` failures keep the platform's typed status and ids in the local repro record
// (tsk_da2dba3d, Docs tcm_02f33c28). The same 404 gave MCP {outcome refused, http_status 404,
// trace_id} but the CLI {outcome unknown, http_status null, ids null}: the tool-error envelope's
// top-level http_status and _repro.collected ids were dropped. A transport failure (no tool
// result) stays unknown; nothing untyped, and no planted secret, reaches the record or packet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const TRACE = '0123456789abcdef0123456789abcdef';
const CANARIES = ['smt_CANARYdevkey0000000000000000', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJl', 'canary-password-hunter2', 'canary@example.invalid', "SELECT * FROM canary_users", 'sk_test_CANARY000000000000000000', '?token=CANARYQUERY'];
const plant = CANARIES.join(' ');

/** The platform's tool-error envelope, the shape observed live on 2026-10-22 for support_ticket 404. */
const envelope = (over = {}) => ({
  ok: false, error: 'NOT_FOUND', message: `Ticket not found ${plant}`, hint: `try again ${plant}`,
  error_code: 'NOT_FOUND', http_status: 404, canonical_error: { code: 'NOT_FOUND', http_status: 404 },
  data: { detail: plant },
  _repro: { schema: 'somewhere.repro/1', collected: { schema: 'somewhere.repro/1', code: 'NOT_FOUND', outcome: 'refused', http_status: 404, operation: 'tool:support_ticket', trace_id: TRACE },
    omitted: [plant], surface: 'mcp', recipe: { kind: 'synthetic', rerun_original: false, steps: [plant], investigate: [] }, submit: { destination: 'support_ticket', automatic: false, how: plant } },
  ...over,
});

function send(res, payload) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); }

async function run(onToolsCall) {
  const home = mkdtempSync(join(tmpdir(), 'call-repro-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_call_repro_test', user: { email: 't@example.com' } }));
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const rpc = body ? JSON.parse(body) : {};
      if (rpc.method === 'initialize') send(res, { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
      else if (rpc.method === 'tools/call') onToolsCall(req, res, rpc);
      else send(res, { jsonrpc: '2.0', id: rpc.id, result: {} });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env, HOME: home, USERPROFILE: home, SOMEWHERE_CONFIG_DIR: join(home, '.somewhere'), SOMEWHERE_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`, CI: '1', NO_COLOR: '1' };
  const cli = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [distIndex, ...args], { cwd: home, env });
    let out = '', err = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  try {
    const call = await cli(['call', 'support_ticket', '{"ticket_id":"pfb_000000000000"}']);
    const packet = await cli(['support', 'packet', '--json']);
    const raw = readFileSync(join(home, '.somewhere', 'last-error.json'), 'utf8');
    return { call, packet: JSON.parse(packet.out), packetText: packet.out, raw };
  } finally { server.close(); }
}

const collected = (p) => (p.data ?? p).collected ?? (p.data ?? p).packet?.collected;
const noCanary = (...texts) => { for (const t of texts) for (const c of CANARIES) assert.ok(!t.includes(c), `canary leaked: ${c.slice(0, 12)}`); };

test('a definite 404 on `somewhere call` is recorded as refused with its status and trace, like MCP', async () => {
  const r = await run((req, res, rpc) => send(res, { jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify(envelope()) }] } }));
  assert.equal(r.call.code, 1);
  const c = collected(r.packet);
  assert.deepEqual({ code: c.code, outcome: c.outcome, http_status: c.http_status, operation: c.operation, trace_id: c.trace_id, request_id: c.request_id ?? null },
    { code: 'NOT_FOUND', outcome: 'refused', http_status: 404, operation: 'tool:support_ticket', trace_id: TRACE, request_id: null }, 'matches the MCP _repro.collected fields');
  noCanary(r.packetText, r.raw);
});

test('a transport failure (no tool result) stays unknown and invents no HTTP status', async () => {
  const r = await run((req) => req.socket.destroy());
  assert.equal(r.call.code, 1);
  const c = collected(r.packet);
  assert.equal(c.outcome, 'unknown');
  assert.equal(c.http_status ?? null, null);
  assert.equal(c.operation, 'tool:support_ticket');
  assert.equal(c.trace_id ?? null, null);
});

test('forged or malformed status and ids are dropped, so the outcome falls back to unknown', async () => {
  const bad = envelope({ http_status: '404', canonical_error: { http_status: 999 }, trace_id: `${CANARIES[0]} x`, request_id: 'req with spaces',
    _repro: { collected: { http_status: 'NaN', trace_id: CANARIES[1], request_id: '../etc' } } });
  const r = await run((req, res, rpc) => send(res, { jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify(bad) }] } }));
  const c = collected(r.packet);
  assert.equal(c.code, 'NOT_FOUND');
  assert.equal(c.http_status ?? null, null);
  assert.equal(c.trace_id ?? null, null);
  assert.equal(c.request_id ?? null, null);
  assert.equal(c.outcome, 'unknown');
  noCanary(r.packetText, r.raw);
});

test('a mutating tool error with http_status 500 records outcome unknown (never a retry suggestion) and keeps the status', async () => {
  const e500 = envelope({ error: 'INTERNAL_ERROR', error_code: 'INTERNAL_ERROR', http_status: 500, canonical_error: { code: 'INTERNAL_ERROR', http_status: 500 },
    _repro: { collected: { code: 'INTERNAL_ERROR', outcome: 'unknown', http_status: 500, trace_id: TRACE } } });
  const r = await run((req, res, rpc) => send(res, { jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify(e500) }] } }));
  const c = collected(r.packet);
  assert.equal(c.code, 'INTERNAL_ERROR');
  assert.equal(c.http_status, 500);
  assert.equal(c.outcome, 'unknown');
  assert.equal(c.operation, 'tool:support_ticket');
  const recipe = JSON.stringify((r.packet.data ?? r.packet).recipe ?? (r.packet.data ?? r.packet).packet?.recipe ?? {});
  assert.doesNotMatch(recipe, /"rerun_original":true/, 'an unknown outcome is never suggested as a rerun');
  noCanary(r.packetText, r.raw);
});
