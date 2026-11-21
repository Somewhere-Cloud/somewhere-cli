import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRoundtripServing } from '../scripts/e2e-roundtrip-probe.mjs';

const origin = 'https://swtest-roundtrip.somewhere.site';
const marker = 'round-trip fixture test-project';
const refusal = () => Response.json({
  ok: false, error: 'FUNCTION_NOT_FOUND', message: 'No function registered at /_lib/secret.ts',
}, { status: 404 });

test('validates the exact fixture on its canonical host before accepting the private refusal', async () => {
  const requests = [];
  await verifyRoundtripServing('swtest-roundtrip', marker, async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'error');
    return requests.length === 1 ? new Response(marker) : refusal();
  });
  assert.deepEqual(requests, [origin + '/roundtrip-health.txt', origin + '/_lib/secret.ts']);
});

test('a generic 404 or unrelated 200 at the public file cannot prove a private refusal', async () => {
  for (const response of [new Response('unknown host', { status: 404 }), new Response('different release')]) {
    let calls = 0;
    await assert.rejects(verifyRoundtripServing('swtest-roundtrip', marker, async () => {
      calls++;
      return response;
    }), /without the deployed fixture marker/);
    assert.equal(calls, 1);
  }
});

test('an ordinary 404 and leaked helper source both fail the private-path check', async () => {
  for (const response of [new Response('unknown host', { status: 404 }), new Response('private source')]) {
    await assert.rejects(verifyRoundtripServing('swtest-roundtrip', marker, async (url) =>
      url.endsWith('/roundtrip-health.txt') ? new Response(marker) : response),
    /without the expected FUNCTION_NOT_FOUND refusal/);
  }
});
