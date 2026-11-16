// bench-1115c frictions: a failure names the page it happened on, and `somewhere test` starts with the last deploy's
// background reference check when it is not clean.
import assert from 'node:assert/strict';
import test from 'node:test';
import { scrub } from '../dist/lib/test-diagnostics.js';
import { describeReferenceCheck, referenceCheckNote } from '../dist/lib/reference-check-note.js';

test('the app\'s own pages keep their path; the query, fragment and credential-shaped segments are hidden', () => {
  const before = process.env.SW_TEST_ORIGIN;
  process.env.SW_TEST_ORIGIN = 'https://crew.somewhere.site';
  try {
    const cases = [
      ['https://crew.somewhere.site/teams/3f2a9c1e-5b6d-4e8f-9a0b-1c2d3e4f5a6b/tasks', 'https://crew.somewhere.site/teams/3f2a9c1e-5b6d-4e8f-9a0b-1c2d3e4f5a6b/tasks'],
      ['https://crew.somewhere.site/teams?invite=abc&next=/home#done', 'https://crew.somewhere.site/teams?[redacted]#[redacted]'],
      ['https://crew.somewhere.site/join/Xk9fQ2mLp7RtZb4Wc8Nd', 'https://crew.somewhere.site/join/[redacted]'],
      ['https://crew.somewhere.site/confirm/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 'https://crew.somewhere.site/confirm/[redacted]'],
      ['https://crew.somewhere.site/v1/fs-signed/abc.def', 'https://crew.somewhere.site/v1/fs-signed/[redacted]'],
      ['https://crew.somewhere.site/v1/upload/u_123', 'https://crew.somewhere.site/v1/upload/[redacted]'],
      ['https://crew.somewhere.site/v1/scratch/tok', 'https://crew.somewhere.site/v1/scratch/[redacted]'],
      ['https://crew.somewhere.site/verify/vrf_capability_42', 'https://crew.somewhere.site/verify/[redacted]'],
      ['https://api.somewhere.cloud/v1/projects/p-1', 'https://api.somewhere.cloud/[redacted-url]'],
    ];
    for (const [url, shown] of cases) assert.equal(scrub(url), shown, url);
    assert.equal(scrub('page 1: https://crew.somewhere.site/teams. Then'), 'page 1: https://crew.somewhere.site/teams. Then', 'trailing punctuation stays outside the URL');
  } finally { if (before === undefined) delete process.env.SW_TEST_ORIGIN; else process.env.SW_TEST_ORIGIN = before; }
  assert.equal(scrub('https://crew.somewhere.site/teams'), 'https://crew.somewhere.site/[redacted-url]', 'with no app origin known, every path is hidden');
});

test('the background reference check is reported only when it found warnings or did not run', async () => {
  assert.equal(describeReferenceCheck({ version: 7, reference_check: { status: 'checked', findings: 0 } }), null);
  assert.equal(describeReferenceCheck({ version: 7, reference_check: { status: 'pending' } }), null);
  assert.equal(describeReferenceCheck({ version: 7 }), null);
  assert.equal(describeReferenceCheck({ version: 7, reference_check: { status: 'checked', findings: 2 } }),
    'The last deploy\'s background reference check found 2 warnings; read them with: somewhere call project_deploy_log \'{"version":7}\'');
  assert.match(describeReferenceCheck({ version: 7, reference_check: { status: 'unavailable', reason: 'not_finished' } }), /never finished, so its warnings are unknown/);
  let asked;
  const client = { call: async (method, path, body, query) => { asked = [method, path, query]; return { version: 3, reference_check: { status: 'checked', findings: 1 } }; } };
  assert.match(await referenceCheckNote(() => client, 'p-1'), /found 1 warning;/);
  assert.deepEqual(asked, ['GET', '/deploy/log', { project_id: 'p-1' }]);
  assert.match(await referenceCheckNote(() => { throw new Error('Not logged in'); }, 'p-1'), /Could not read .*: Not logged in/, 'a failed read says so');
});
