import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setCookieValues } from '../dist/lib/playwright-fixtures.js';

// Slow-calls 5.3: a fixture request remembers the cookies it set from its own response's Set-Cookie headers,
// instead of reading the whole cookie jar from the Playwright driver after every call (~35-40 ms each).

const response = (headers) => ({ headersArray: () => headers });

test('every cookie value a response sets is remembered, as sent', () => {
  const values = setCookieValues(response([
    { name: 'Content-Type', value: 'application/json' },
    { name: 'set-cookie', value: '__Host-token=eyJhbGciOi.payload.sig; Path=/; HttpOnly; Secure; SameSite=Lax' },
    { name: 'Set-Cookie', value: 'sw_refresh=r_abc=def; Path=/; Max-Age=3600' },
    { name: 'set-cookie', value: 'cleared=; Path=/; Max-Age=0' },
    { name: 'set-cookie', value: 'noequals' },
  ]));
  assert.deepEqual(values, ['eyJhbGciOi.payload.sig', 'r_abc=def']);
});

test('a response that sets no cookie adds nothing', () => {
  assert.deepEqual(setCookieValues(response([{ name: 'content-type', value: 'text/plain' }])), []);
});

test('the request wrapper no longer reads the whole cookie jar per request', () => {
  const source = readFileSync(new URL('../src/lib/playwright-fixtures.ts', import.meta.url), 'utf8');
  const wrapper = source.slice(source.indexOf('function constrain('), source.indexOf('\n}\n', source.indexOf('function constrain(')));
  assert.ok(wrapper.includes('setCookieValues(response)'), 'remembers the response cookies');
  assert.ok(!/storageState\(/.test(wrapper), 'no per-request storageState');
});
