import assert from 'node:assert/strict';
import test from 'node:test';
import { CliApiError } from '../dist/lib/client.js';
import { runPreviewScheduleTest } from '../dist/lib/test-preview-job.js';

const target = { preview_session_id: 'draft_fixture', preview_id: 'rel_fixture' };
const notice = 'The handler runs against your preview data and can change it.';
const postResponse = (i) => ({
  status: 202, headers: { 'x-request-id': 'request-' + i },
  body: JSON.stringify({ ok: true, data: { ...target, job_id: 'job_' + i, timeout_seconds: 270 } }),
});

test('uncertain admission keeps the request ID and sends one POST even with --twice', async () => {
  const seen = [];
  const client = {
    call: async (method, path, body, query) => {
      assert.equal(method, 'GET');
      assert.equal(query.job_id, undefined);
      return { ...target, notice, row_counts: {} };
    },
    callRaw: async (method, path, body, options) => {
      assert.equal(method, 'POST');
      assert.deepEqual(body, target);
      assert.equal(options.redirect, 'error');
      seen.push('post');
      throw new CliApiError('RESPONSE_BODY_TIMEOUT', 'body unavailable', 202, undefined, undefined, { requestId: 'request-lost' });
    },
  };
  const [run] = await runPreviewScheduleTest(client, 'cron_fixture', target, true, (line) => seen.push(line));
  assert.deepEqual(seen, [notice, 'post']);
  assert.equal(run.status, 'unknown');
  assert.equal(run.request_id, 'request-lost');
  assert.match(run.detail, /admission is unknown/i);
});

test('a terminal failure reports its status, duration and IDs', async () => {
  const client = {
    call: async (_method, _path, _body, query) => ({
      ...target, notice,
      ...(query.job_id ? { job: { job_id: query.job_id, status: 'failed', terminal: true, duration_ms: 420, error_code: 'HANDLER_ERROR' } } : {}),
    }),
    callRaw: async () => postResponse(1),
  };
  assert.deepEqual(await runPreviewScheduleTest(client, 'cron_fixture', target, false, () => {}), [{
    status: 'failed', duration_ms: 420, job_id: 'job_1', request_id: 'request-1', detail: 'HANDLER_ERROR',
  }]);
});

test('twice waits for the first terminal status and reports each observed count change', async () => {
  const history = [];
  let posts = 0;
  let polls = 0;
  const client = {
    call: async (_method, _path, _body, query) => {
      assert.equal(query.counts, 1);
      if (!query.job_id) return { ...target, notice, row_counts: { items: 3, config: 1 } };
      history.push(query.job_id);
      if (++polls === 1) return { ...target, notice, job: { job_id: query.job_id, status: 'running', terminal: false } };
      return { ...target, notice, job: { job_id: query.job_id, status: 'complete', terminal: true, duration_ms: 100, error_code: null },
        row_counts: { items: query.job_id === 'job_1' ? 4 : 6, config: 1 } };
    },
    callRaw: async () => {
      history.push('post' + ++posts);
      return postResponse(posts);
    },
  };
  const result = await runPreviewScheduleTest(client, 'cron_fixture', target, true, () => {}, async () => {});
  assert.deepEqual(history, ['post1', 'job_1', 'job_1', 'post2', 'job_2']);
  assert.deepEqual(result.map((run) => run.row_count_changes), [
    [{ table: 'items', before: 3, after: 4 }], [{ table: 'items', before: 4, after: 6 }],
  ]);
});
