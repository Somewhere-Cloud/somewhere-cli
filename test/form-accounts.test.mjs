import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { admitReservedAddress, generatedAddress, generatedPassword, recordAttempt, recordId, sweepAccounts, describeSweep, accountsDir } from '../dist/lib/form-accounts.js';
import { CliApiError } from '../dist/lib/client.js';
import { rememberSecrets, scrub } from '../dist/lib/test-diagnostics.js';

test('a chosen sign-up address is admitted only at a reserved name, by one strict rule', () => {
  for (const ok of ['ana@example.com', 'ana@example.org', 'ana@example.net', 'ana@staff.example', 'ana@qa.acme.test',
    'Ana.B+tag@STAFF.Example', 'a_b-c@x.y.test', 'ana@xn--bcher-kva.example']) {
    assert.equal(admitReservedAddress(ok), ok.toLowerCase(), ok);
  }
  const refused = {
    'ana@acme.com': 'not a reserved domain',
    'ana@example.com.evil.com': 'not a reserved domain',
    'ana@evil-example.com': 'not a reserved domain',
    'ana@sub.example.com': 'not a reserved domain',
    'ana@example': 'not a reserved domain',
    'ana@test': 'not a reserved domain',
    'ana@example.testing': 'not a reserved domain',
    'ana@staff.example.': 'no trailing dot',
    'ana@@staff.example': 'exactly one @',
    'ana@b@staff.example': 'exactly one @',
    'staff.example': 'exactly one @',
    'ana@staff..example': 'dot-separated',
    'ana@-x.example': 'dot-separated',
    'ana@x_y.example': 'dot-separated',
    'ana@bücher.example': 'plain ASCII',
    'аna@staff.example': 'plain ASCII', // Cyrillic a
    'ana@staff.examplе': 'plain ASCII', // Cyrillic e
    ' ana@staff.example': 'plain ASCII',
    'ana@staff.example ': 'plain ASCII',
    'Ana <ana@staff.example>': 'plain ASCII',
    '"ana"@staff.example': 'the part before @',
    '.ana@staff.example': 'the part before @',
    'an..a@staff.example': 'the part before @',
    '@staff.example': 'the part before @',
  };
  for (const [value, why] of Object.entries(refused)) {
    assert.throws(() => admitReservedAddress(value), (error) => error.message.includes(why) && error.message.includes('example.com, example.org, example.net'), value);
  }
  assert.throws(() => admitReservedAddress(42), /must be a string/);
  assert.throws(() => generatedAddress('acme.com'), /not a reserved domain/);
});

test('generated addresses and passwords are fresh and reserved', () => {
  const a = generatedAddress();
  assert.match(a, /^sw-[0-9a-f]{12}@example\.com$/);
  assert.notEqual(a, generatedAddress());
  assert.match(generatedAddress('staff.example'), /^sw-[0-9a-f]{12}@staff\.example$/);
  const password = generatedPassword();
  assert.ok(password.length >= 20 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password));
});

test('the run record is private, never holds a secret, and cleanup is by exact id only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-form-accounts-'));
  const project = 'aaaaaaaa-1111-4111-8111-111111111111';
  // An interrupted earlier run: its runner pid no longer exists.
  process.env.SW_TEST_RUN = 'interrupted-run';
  process.env.SW_TEST_RUN_PID = '999999998';
  const withId = recordAttempt(root, project, 'sw-1@example.com');
  recordId(withId, 'user-1');
  recordAttempt(root, project, 'sw-2@staff.example'); // submitted, id never learned
  const gone = recordAttempt(root, project, 'sw-3@example.com');
  recordId(gone, 'user-3');
  const failing = recordAttempt(root, project, 'sw-4@example.com');
  recordId(failing, 'user-4');
  // A record of another run that is still alive (this test process stands in for it) is left alone.
  process.env.SW_TEST_RUN = 'other-run';
  process.env.SW_TEST_RUN_PID = String(process.pid);
  const live = recordAttempt(root, project, 'sw-5@example.com');
  recordId(live, 'user-5');
  const dir = accountsDir(root, project);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const name of readdirSync(dir)) {
    assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, name), 'utf8'))).sort(), ['created_at', 'email', 'id', 'pid', 'project_id', 'run']);
  }
  const calls = [];
  const client = { async call(method, path, body, query) {
    calls.push({ method, path, body, query });
    if (path.endsWith('/user-3')) throw new CliApiError('AUTH_INVALID_CREDS', 'User not found in this project.', 404);
    if (path.endsWith('/user-4')) throw new CliApiError('INTERNAL_ERROR', 'boom', 500);
    return { deleted: true };
  } };
  // The sweep runs in a different process from the live run; mark this one as finished.
  process.env.SW_TEST_RUN = 'sweeper';
  const original = process.pid;
  Object.defineProperty(process, 'pid', { value: 999999999, configurable: true });
  let result;
  try { result = await sweepAccounts(client, root, project); } finally { Object.defineProperty(process, 'pid', { value: original, configurable: true }); }
  assert.deepEqual(calls.map(call => `${call.method} ${call.path} ${call.query.project_id}`).sort(), [
    `DELETE /auth/users/user-1 ${project}`, `DELETE /auth/users/user-3 ${project}`, `DELETE /auth/users/user-4 ${project}`]);
  assert.ok(calls.every(call => call.body === undefined), 'deletion is by id only, never by address');
  assert.deepEqual(result.deleted.sort(), ['user-1', 'user-3']);
  assert.deepEqual(result.failed, ['sw-4@example.com']);
  assert.deepEqual(result.unknownId, ['sw-2@staff.example']);
  const left = readdirSync(dir).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')).email).sort();
  assert.deepEqual(left, ['sw-4@example.com', 'sw-5@example.com'], 'a failed delete keeps its record for the next run; a live run keeps its own');
  const lines = describeSweep(result, 'Before this run').join('\n');
  assert.match(lines, /deleted 2/);
  assert.match(lines, /could not delete 1.*sw-4@example\.com.*next run retries/);
  assert.match(lines, /never deleted by address.*sw-2@staff\.example/);
  assert.throws(() => accountsDir(root, '../escape'), /Unexpected project id/);
});

test('passwords and codes the fixtures handled are scrubbed from any text', () => {
  const password = generatedPassword();
  rememberSecrets(password, '482913');
  assert.equal(scrub(`locator.fill("${password}") failed; code 482913 rejected`), 'locator.fill("[redacted]") failed; code [redacted] rejected');
});
