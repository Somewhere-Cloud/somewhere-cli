import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { leadingZeroBits, solvePow, mintTempAccount } from '../dist/lib/temp-auth.js';

test('leadingZeroBits — hand-computed digests', () => {
  // 0x00 alone = a fully-zero byte = 8 leading zero bits.
  assert.equal(leadingZeroBits(Buffer.from([0x00])), 8);
  // 0x00 then 0x80 (0b10000000): the first byte contributes its 8 zero bits,
  // then the second byte's top bit is already 1 — 0 more. Total 8, not 16.
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x80])), 8);
  // 0x0F = 0b00001111 — 4 leading zero bits before the first 1.
  assert.equal(leadingZeroBits(Buffer.from([0x0f])), 4);
  // Two fully-zero bytes then a non-zero one — 16 leading zero bits.
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x00, 0xff])), 16);
  // 0xFF — the very first bit is already 1 — 0 leading zero bits.
  assert.equal(leadingZeroBits(Buffer.from([0xff])), 0);
});

test('solvePow — difficulty 8 returns a suffix whose recomputed sha256 verifies', () => {
  const nonce = 'tmpc_test_nonce_1';
  const { suffix, hash } = solvePow(nonce, 8);
  const recomputed = createHash('sha256').update(`${nonce}:${suffix}`, 'utf8').digest();
  assert.equal(recomputed.toString('hex'), hash);
  assert.ok(leadingZeroBits(recomputed) >= 8);
});

test('solvePow — difficulty 12 returns a suffix whose recomputed sha256 verifies', () => {
  const nonce = 'tmpc_test_nonce_2';
  const { suffix, hash } = solvePow(nonce, 12);
  const recomputed = createHash('sha256').update(`${nonce}:${suffix}`, 'utf8').digest();
  assert.equal(recomputed.toString('hex'), hash);
  assert.ok(leadingZeroBits(recomputed) >= 12);
});

// mintTempAccount runs through an ApiClient (unauthenticated in production);
// a fake client here records each call. HTTP envelopes, typed errors and
// non-JSON bodies are covered end to end in deploy-anonymous-errors.test.mjs.
function fakeClient(responses) {
  const calls = [];
  return { calls, call: async (method, path, body, query, opts) => {
    calls.push({ method, path, body, opts });
    const reply = responses[path];
    if (reply instanceof Error) throw reply;
    return reply;
  } };
}
const CHALLENGE = { nonce: 'tmpc_abc', difficulty: 1, algorithm: 'sha256', input: 'tmpc_abc:<suffix>', expires_at: '2026-07-02T13:00:00.000Z', ttl_seconds: 600 };

test('mintTempAccount — GET challenge then POST create with {nonce, suffix}, never refreshing a stored login', async () => {
  const client = fakeClient({
    '/auth/pow/challenge': CHALLENGE,
    '/auth/temp-create': {
      access_token: 'smt_fallback_should_not_be_used', key: 'smt_temp_123', key_prefix: 'smt_temp', key_id: 'key_1',
      scopes: ['projects', 'deploy'], expires_at: '2026-07-02T16:00:00.000Z', ttl_seconds: 10800,
      claim_token: 'swtc_xyz', claim_url: 'https://somewhere.cloud/claim?token=swtc_xyz',
    },
  });
  const account = await mintTempAccount(client);
  assert.deepEqual(client.calls.map((c) => [c.method, c.path]), [['GET', '/auth/pow/challenge'], ['POST', '/auth/temp-create']]);
  assert.deepEqual(client.calls[1].body, { nonce: 'tmpc_abc', suffix: expectedSuffix('tmpc_abc', 1) });
  assert.ok(client.calls.every((c) => c.opts?.refresh === false));
  // `key` is preferred over `access_token` when both are present.
  assert.equal(account.key, 'smt_temp_123');
  assert.equal(account.claim_url, 'https://somewhere.cloud/claim?token=swtc_xyz');
  assert.equal(account.ttl_seconds, 10800);
});

test('mintTempAccount — falls back to access_token when key is absent', async () => {
  const client = fakeClient({
    '/auth/pow/challenge': { ...CHALLENGE, nonce: 'n' },
    '/auth/temp-create': { access_token: 'smt_only_access_token', scopes: [], expires_at: 'x', ttl_seconds: 10800, claim_token: 'swtc_1', claim_url: 'https://somewhere.cloud/claim?token=swtc_1' },
  });
  assert.equal((await mintTempAccount(client)).key, 'smt_only_access_token');
});

test('mintTempAccount — a challenge without nonce/difficulty is a typed INVALID_RESPONSE, not a solve attempt', async () => {
  const client = fakeClient({ '/auth/pow/challenge': { unexpected: true } });
  await assert.rejects(() => mintTempAccount(client), (err) => err.code === 'INVALID_RESPONSE');
  assert.equal(client.calls.length, 1);
});

// Recompute the same suffix search the module does, purely to build the
// expected POST body for the "GET then POST" assertion above.
function expectedSuffix(nonce, difficulty) {
  let i = 0;
  for (;;) {
    const suffix = (i++).toString(36);
    const hash = createHash('sha256').update(`${nonce}:${suffix}`, 'utf8').digest();
    let bits = 0;
    for (const byte of hash) {
      if (byte === 0) { bits += 8; continue; }
      let mask = 0x80;
      while (mask > 0 && (byte & mask) === 0) { bits++; mask >>= 1; }
      break;
    }
    if (bits >= difficulty) return suffix;
  }
}
