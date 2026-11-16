import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { admitReservedAddress, generatedAddress, generatedPassword, recordAttempt, recordId, sweepAccounts, describeSweep, accountsDir } from '../dist/lib/form-accounts.js';
import { CliApiError } from '../dist/lib/client.js';
import { productionControl, previewControl, previewAccountsDir } from '../dist/lib/test-control.js';
import { rememberSecrets, scrub } from '../dist/lib/test-diagnostics.js';

test('a chosen sign-up address is admitted only at a reserved name, by one strict rule', () => {
  for (const ok of ['ana@example.com', 'ana@example.org', 'ana@example.net', 'ana@staff.example', 'ana@qa.acme.test',
    'Ana.B+tag@STAFF.Example', 'a_b-c@x.y.test', 'ana@xn--bcher-kva.example']) {
    assert.equal(admitReservedAddress(ok), ok, `${ok}: returned as given, never lowercased`);
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
  const prodRecorder = productionControl({ call: async () => { throw new Error('no call while recording'); } }, { projectId: project, origin: 'https://app.test', host: 'app.test', releaseId: 'rel_1', contractDigest: null });
  process.env.SW_TEST_RUN = 'interrupted-run';
  process.env.SW_TEST_RUN_PID = '999999998';
  const withId = recordAttempt(prodRecorder, root, 'sw-1@example.com');
  recordId(withId, 'user-1');
  recordAttempt(prodRecorder, root, 'sw-2@staff.example'); // submitted, id never learned
  const gone = recordAttempt(prodRecorder, root, 'sw-3@example.com');
  recordId(gone, 'user-3');
  const failing = recordAttempt(prodRecorder, root, 'sw-4@example.com');
  recordId(failing, 'user-4');
  // A record of another run that is still alive (this test process stands in for it) is left alone.
  process.env.SW_TEST_RUN = 'other-run';
  process.env.SW_TEST_RUN_PID = String(process.pid);
  const live = recordAttempt(prodRecorder, root, 'sw-5@example.com');
  recordId(live, 'user-5');
  const dir = accountsDir(root, project);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const name of readdirSync(dir)) {
    assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, name), 'utf8'))).sort(), ['created_at', 'email', 'environment', 'id', 'pid', 'project_id', 'run']);
  }
  const calls = [];
  // One call for every finished record (DESIGN.md slice 3a follow-ups, part B): user-3 is already gone,
  // user-4 is the only owner of a team with someone outside the list.
  const client = { async call(method, path, body, query) {
    calls.push({ method, path, body, query });
    return { results: body.ids.map((id) => id === 'user-3' ? { id, outcome: 'not_found' } : id === 'user-4' ? { id, outcome: 'kept', groups: [{ id: 'grp_1', name: 'Shared' }] } : { id, outcome: 'deleted' }),
      groups_deleted: [{ id: 'grp_2', name: 'Only them' }] };
  } };
  // The sweep runs in a different process from the live run; mark this one as finished.
  process.env.SW_TEST_RUN = 'sweeper';
  const original = process.pid;
  Object.defineProperty(process, 'pid', { value: 999999999, configurable: true });
  let result;
  try { result = await sweepAccounts(productionControl(client, { projectId: project, origin: 'https://app.test', host: 'app.test', releaseId: 'rel_1', contractDigest: null }), root); } finally { Object.defineProperty(process, 'pid', { value: original, configurable: true }); }
  assert.deepEqual(calls.map(call => `${call.method} ${call.path} ${call.query.project_id}`), [`POST /auth/users/delete ${project}`], 'one call for all of them');
  assert.deepEqual({ ...calls[0].body, ids: [...calls[0].body.ids].sort() }, { ids: ['user-1', 'user-3', 'user-4'], delete_groups_only_they_belong_to: true }, 'by exact id only, never by address');
  assert.deepEqual(result.deleted.sort(), ['user-1', 'user-3']);
  assert.deepEqual(result.failed, ['sw-4@example.com (it is the only owner of the team "Shared" (grp_1), which has members outside this run\'s sign-ups; the team and the account were left alone)'], 'a kept account says which team and that it was left alone');
  assert.deepEqual(result.teamsDeleted, ['"Only them" (grp_2)']);
  assert.deepEqual(result.unknownId, ['sw-2@staff.example']);
  const left = readdirSync(dir).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')).email).sort();
  assert.deepEqual(left, ['sw-4@example.com', 'sw-5@example.com'], 'a failed delete keeps its record for the next run; a live run keeps its own');
  const lines = describeSweep(result, 'Before this run').join('\n');
  assert.match(lines, /deleted 2/);
  assert.match(lines, /deleted 1 team\(s\) that only those sign-ups belonged to: "Only them" \(grp_2\)/);
  assert.match(lines, /could not delete 1.*sw-4@example\.com.*next run retries/);
  assert.match(lines, /never deleted by address.*sw-2@staff\.example/);
  assert.throws(() => accountsDir(root, '../escape'), /Unexpected project id/);
  // A call that fails as a whole keeps every record and says what the platform answered.
  const broken = { async call() { throw new CliApiError('INTERNAL_ERROR', 'boom', 500); } };
  process.env.SW_TEST_RUN = 'sweeper-2';
  Object.defineProperty(process, 'pid', { value: 999999999, configurable: true });
  try {
    const again = await sweepAccounts(productionControl(broken, { projectId: project, origin: 'https://app.test', host: 'app.test', releaseId: 'rel_1', contractDigest: null }), root);
    assert.deepEqual(again.failed, ['sw-4@example.com (HTTP 500 INTERNAL_ERROR: boom)']);
  } finally { Object.defineProperty(process, 'pid', { value: original, configurable: true }); }
});

test('passwords and codes the fixtures handled are scrubbed from any text', () => {
  const password = generatedPassword();
  rememberSecrets(password, '482913');
  assert.equal(scrub(`locator.fill("${password}") failed; code 482913 rejected`), 'locator.fill("[redacted]") failed; code [redacted] rejected');
});

// Slice 3a (Astra slice-3 check A4): sign-ups made in a preview are recorded and removed apart from
// production's. A preview sweep sees only its own preview's records and removes them only with the
// preview tool; a retained production record in the same folder is never read, finished or deleted.
test('a preview run never touches a production cleanup record, and a production run never touches a preview one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sw-form-accounts-preview-'));
  const project = 'bbbbbbbb-2222-4222-8222-222222222222';
  const draftA = 'draft_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', draftB = 'draft_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const target = (draft) => ({ projectId: project, origin: 'https://app-dev.test', host: 'app-dev.test', releaseId: 'rel_candidate_1', contractDigest: null, environment: 'preview', previewSessionId: draft });
  const production = { projectId: project, origin: 'https://app.test', host: 'app.test', releaseId: 'rel_1', contractDigest: null };
  const calls = [];
  const recording = (label) => ({ call: async (method, path, body) => { calls.push(`${label} ${method} ${path} ${body.ids.join(',')}`); return { results: body.ids.map((id) => ({ id, outcome: 'deleted' })), groups_deleted: [] }; } });
  process.env.SW_TEST_RUN = 'ended-run'; process.env.SW_TEST_RUN_PID = '999999998';
  // An interrupted production run left a record with a known id; an interrupted preview A run and B run left theirs.
  const prod = recordAttempt(productionControl(recording('prod'), production), root, 'sw-prod@example.com'); recordId(prod, 'prod-user-1');
  const a = recordAttempt(previewControl(recording('A'), target(draftA)), root, 'sw-a@example.com'); recordId(a, 'pvu_a1');
  const b = recordAttempt(previewControl(recording('B'), target(draftB)), root, 'sw-b@example.com'); recordId(b, 'pvu_b1');
  const prodBefore = readFileSync(prod, 'utf8');
  assert.ok(prod.startsWith(accountsDir(root, project)) && a.startsWith(previewAccountsDir(root, project, draftA)) && b.startsWith(previewAccountsDir(root, project, draftB)), 'three separate journals');
  assert.deepEqual({ ...JSON.parse(readFileSync(a, 'utf8')), created_at: 0, pid: 0, run: '' }, { project_id: project, email: 'sw-a@example.com', id: 'pvu_a1', run: '', pid: 0, created_at: 0, environment: 'preview', preview_session_id: draftA });
  process.env.SW_TEST_RUN = 'preview-a-run';
  const swept = await sweepAccounts(previewControl(recording('A'), target(draftA)), root);
  assert.deepEqual(swept.deleted, ['pvu_a1']);
  assert.deepEqual(calls, ['A POST /preview-tools/signups/delete pvu_a1'], 'only preview A\'s record, only through the preview tool');
  assert.equal(readFileSync(prod, 'utf8'), prodBefore, 'the production record is untouched');
  assert.ok(existsSync(b), 'preview B\'s record is left to a preview B run');
  // A production record placed in a preview's journal by mistake is still never finished by a preview run.
  const stray = join(previewAccountsDir(root, project, draftA), '1-deadbeef.json');
  writeFileSync(stray, JSON.stringify({ project_id: project, email: 'sw-stray@example.com', id: 'prod-user-9', run: 'x', pid: 0, created_at: '' }));
  calls.length = 0;
  await sweepAccounts(previewControl(recording('A'), target(draftA)), root);
  assert.deepEqual(calls, [], 'a record that does not name this preview is never acted on');
  // And a production sweep never touches preview records, even one placed in the production journal by mistake.
  writeFileSync(join(accountsDir(root, project), '2-deadbeef.json'), JSON.stringify({ project_id: project, email: 'sw-misplaced@example.com', id: 'pvu_misplaced', run: 'x', pid: 0, created_at: '', environment: 'preview', preview_session_id: draftA }));
  calls.length = 0;
  const prodSwept = await sweepAccounts(productionControl(recording('prod'), production), root);
  assert.deepEqual(calls, ['prod POST /auth/users/delete prod-user-1']);
  assert.deepEqual(prodSwept.deleted, ['prod-user-1']);
  assert.ok(existsSync(b));
  // A closed preview took its accounts with it: the record is dropped with the reason, never retried
  // for ever (DESIGN.md slice 3a follow-ups, part B); nothing falls back to production.
  calls.length = 0;
  const dead = { call: async (method, path, body) => { calls.push(`B ${method} ${path} ${body.ids.join(',')}`); throw new CliApiError('PREVIEW_CREDENTIAL_INVALID', 'closed', 401); } };
  const closed = await sweepAccounts(previewControl(dead, target(draftB)), root);
  assert.deepEqual(calls, ['B POST /preview-tools/signups/delete pvu_b1']);
  assert.deepEqual(closed.failed, []);
  assert.match(closed.dropped[0], /sw-b@example\.com \(the preview is closed, promoted or expired, and its accounts went with it\)/);
  assert.ok(!existsSync(b), 'the record is dropped');
  assert.match(describeSweep(closed, 'Before this run').join('\n'), /dropped the cleanup record of 1 form sign-up account\(s\) that can never be deleted/);
});
