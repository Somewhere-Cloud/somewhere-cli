import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const baseCron = { cron_id: 'cron_daily', project_id: 'proj_test', name: 'Daily', schedule: '* * * * *',
  timezone: 'UTC', handler: '/api/digest', payload: {}, enabled: true };
const success = (data) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] });
const refusal = (error, message) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error, message }) }] });
const row = (job_id, at, status = 'queued', extra = {}) => ({ job_id, cron_id: 'cron_daily', trigger: 'scheduled',
  cron_scheduled_at: new Date(at).toISOString(), status, ...extra });

function homeFor(t) {
  const home = mkdtempSync(join(tmpdir(), 'sw-cron-wait-next-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.somewhere'));
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_local_mock',
    user: { email: 'cron@example.com', username: 'cron' } }));
  return home;
}

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distIndex, 'cron', 'runs', 'Daily', '--project', 'proj_test', ...args], {
      cwd: repoRoot, env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '', stderr = '';
    const guard = setTimeout(() => { child.kill(); reject(new Error('CLI exceeded test safety deadline')); }, 8000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => { clearTimeout(guard); resolve({ status, stdout, stderr }); });
  });
}

async function withTransport(t, handler, fn, options = {}) {
  const calls = [];
  const home = homeFor(t);
  if (options.expiringCredentials) writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({
    token: 'smt_local_mock', refresh_token: 'mock_old_refresh', access_expires_at: new Date(0).toISOString(),
    user: { email: 'cron@example.com', username: 'cron' },
  }));
  const server = createServer((req, res) => {
    if (req.url === '/v1/keys/cli-pair/refresh') {
      options.onRefresh?.();
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data: { key: 'smt_rotated_mock', refresh_token: 'mock_new_refresh',
          expires_at: new Date(Date.now() + 86400000).toISOString() } }));
      }, 700);
      return;
    }
    if (req.url === '/v1/auth/whoami') {
      options.onWhoami?.();
      if (options.stallWhoami) return;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'API_KEY_EXPIRED', message: 'Expired key.' }));
      return;
    }
    if (options.rejectMcp) { res.writeHead(401); res.end(); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const rpc = JSON.parse(body);
      let result;
      if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'cron-wait-next-test', version: '1' } };
      else if (rpc.method === 'notifications/initialized' || rpc.method === 'notifications/cancelled') result = {};
      else if (rpc.method === 'tools/call') {
        calls.push(rpc.params);
        assert.ok(['cron_list', 'job_get'].includes(rpc.params.name), 'observation never mutates or invokes a cron');
        result = await handler(rpc.params, calls);
        if (result === null) return; // A deliberately stalled read, aborted by the CLI deadline.
      } else { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await fn({ HOME: home, USERPROFILE: home, SOMEWHERE_MCP_URL: `${url}/mcp`, SOMEWHERE_API_URL: `${url}/v1` }, calls); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('wait-next ignores manual/old rows, pins earliest future scheduled job and reports completion', async t => {
  let slot, reads = 0, lists = 0;
  await withTransport(t, (p) => {
    if (p.name === 'cron_list') return success({ crons: [{ ...baseCron,
      next_run_at: new Date(Date.now() + (++lists > 1 ? 60000 : 1000)).toISOString() }] });
    if (!p.arguments.job_id) {
      slot = Date.now();
      return success({ jobs: [row('job_later', slot + 1, 'complete'),
        row('job_manual', slot, 'complete', { trigger: 'manual' }), row('job_old', 0, 'complete'), row('job_first', slot)] });
    }
    assert.equal(p.arguments.job_id, 'job_first');
    return success(row('job_first', slot, ++reads === 1 ? 'running' : 'complete', {
      started_at: new Date(slot + 10).toISOString(), completed_at: reads === 1 ? null : new Date(slot + 50).toISOString(), result: { sent: 2 },
    }));
  }, async (env, calls) => {
    const out = await run(['--wait-next', '--timeout', '4', '--json'], env);
    assert.equal(out.status, 0, out.stderr);
    const body = JSON.parse(out.stdout);
    assert.equal(body.data.trigger, 'scheduled');
    assert.equal(body.data.job.job_id, 'job_first');
    assert.equal(body.data.job.status, 'complete');
    assert.deepEqual(body.data.job.result, { sent: 2 });
    assert.ok(Date.parse(body.data.job.cron_scheduled_at) > Date.parse(body.data.observed_after));
    assert.ok(body.data.job.started_at && body.data.job.completed_at);
    assert.match(out.stderr, /Next slot \(UTC\):.*Deadline:/);
    assert.equal(calls.filter(c => c.name === 'job_get' && !c.arguments.job_id).length, 1, 'history stops after pinning');
    assert.equal(reads, 2);
    assert.equal(calls.find(c => c.name === 'job_get').arguments.limit, 100);
  });
});

test('wait-next stops when disabled or schedule configuration changes, without following a replacement', async t => {
  for (const change of [{ enabled: false }, { schedule: '0 * * * *' }, { payload: { recipient: 'other' } }]) {
    let lists = 0, slot;
    await withTransport(t, p => {
      if (p.name === 'cron_list') return success({ crons: [{ ...baseCron, ...(lists++ ? change : {}), next_run_at: new Date().toISOString() }] });
      if (!p.arguments.job_id) { slot = Date.now(); return success({ jobs: [row('job_pinned', slot)] }); }
      return success(row('job_pinned', slot, 'running'));
    }, async (env, calls) => {
      const out = await run(['--wait-next', '--timeout', '4', '--json'], env);
      assert.equal(out.status, 1);
      const body = JSON.parse(out.stdout);
      assert.equal(body.error, change.enabled === false ? 'CRON_DISABLED' : 'CRON_CONFIG_CHANGED');
      assert.equal(body.data.job.job_id, 'job_pinned');
      assert.equal(calls.filter(c => c.name === 'job_get' && c.arguments.job_id).length, 1);
    });
  }
});

test('wait-next times out without qualifying occurrence rather than claiming timer failure', async t => {
  await withTransport(t, p => p.name === 'cron_list' ? success({ crons: [{ ...baseCron, next_run_at: new Date(Date.now() + 60000).toISOString() }] })
    : success({ jobs: [row('job_old', 0, 'complete'), row('job_manual', Date.now(), 'complete', { trigger: 'manual' })] }), async env => {
    const out = await run(['--wait-next', '--timeout', '0.5', '--json'], env);
    assert.equal(out.status, 1);
    const body = JSON.parse(out.stdout);
    assert.equal(body.error, 'CRON_SCHEDULED_WAIT_TIMEOUT');
    assert.equal(body.data.job, null);
    assert.match(body.message, /does not establish that the scheduler failed/);
  });
});

test('wait-next retains observed job on completion timeout, and exits nonzero on a failed scheduled job', async t => {
  for (const status of ['running', 'failed']) {
    let slot;
    await withTransport(t, p => {
      if (p.name === 'cron_list') return success({ crons: [{ ...baseCron, next_run_at: new Date().toISOString() }] });
      if (!p.arguments.job_id) { slot = Date.now(); return success({ jobs: [row('job_seen', slot)] }); }
      return success(row('job_seen', slot, status, { error: status === 'failed' ? 'Refused recipient.' : null }));
    }, async env => {
      const out = await run(['--wait-next', '--timeout', '0.5', '--json'], env);
      assert.equal(out.status, 1);
      const body = JSON.parse(out.stdout);
      assert.equal(body.error, status === 'running' ? 'CRON_SCHEDULED_WAIT_TIMEOUT' : 'CRON_SCHEDULED_JOB_FAILED');
      assert.equal(body.data.job.job_id, 'job_seen');
      if (status === 'running') assert.match(body.message, /was observed but did not finish/);
    });
  }
});

test('wait-next preserves typed read authorization failures and does not invoke a manual fallback', async t => {
  await withTransport(t, p => p.name === 'cron_list' ? success({ crons: [{ ...baseCron, next_run_at: new Date().toISOString() }] })
    : refusal('FORBIDDEN', 'No access to run history.'), async env => {
    const out = await run(['--wait-next', '--timeout', '2', '--json'], env);
    assert.equal(out.status, 1);
    assert.equal(JSON.parse(out.stdout).error, 'FORBIDDEN');
    assert.match(JSON.parse(out.stdout).message, /No access/);
  });
});

test('wait-next cancels a stalled read promptly on the observation deadline', async t => {
  await withTransport(t, p => p.name === 'cron_list' ? success({ crons: [{ ...baseCron, next_run_at: new Date().toISOString() }] }) : null,
    async env => {
      const began = Date.now();
      const out = await run(['--wait-next', '--timeout', '0.5', '--json'], env);
      assert.equal(out.status, 1);
      assert.equal(JSON.parse(out.stdout).error, 'CRON_SCHEDULED_WAIT_TIMEOUT');
      assert.ok(Date.now() - began < 4000, 'stalled read cannot keep the process alive beyond the observation budget');
    });
});

test('wait-next lets admitted credential rotation persist after deadline and never polls or replays afterward', async t => {
  let rotations = 0;
  await withTransport(t, () => { throw new Error('No tool read may start after renewal crossed the deadline'); },
    async (env, calls) => {
      const out = await run(['--wait-next', '--timeout', '0.3', '--json'], env);
      assert.equal(out.status, 1);
      assert.equal(JSON.parse(out.stdout).error, 'CRON_SCHEDULED_WAIT_TIMEOUT');
      const saved = JSON.parse(readFileSync(join(env.HOME, '.somewhere', 'config.json'), 'utf8'));
      assert.equal(saved.token, 'smt_rotated_mock');
      assert.equal(saved.refresh_token, 'mock_new_refresh');
      assert.equal(rotations, 1);
      assert.deepEqual(calls, []);
    }, { expiringCredentials: true, onRefresh: () => { rotations++; } });
});

test('wait-next refuses missing/disabled initial cron and usage errors before read transport', async t => {
  for (const rows of [[], [{ ...baseCron, enabled: false }]]) {
    await withTransport(t, () => success({ crons: rows }), async (env, calls) => {
      const missing = await run(['--wait-next', '--timeout', '2', '--json'], env);
      assert.equal(JSON.parse(missing.stdout).error, rows.length ? 'CRON_DISABLED' : 'CRON_NOT_FOUND');
      const before = calls.length;
      for (const args of [['--timeout', '2'], ['--wait-next', '--timeout', 'soon'], ['--wait-next', '--limit', '101']]) {
        const out = await run([...args, '--json'], env);
        assert.equal(JSON.parse(out.stdout).error, 'USAGE_ERROR');
      }
      assert.equal(calls.length, before);
    });
  }
});

test('wait-next reports natural slot and actual timestamps in human output, refusing changed pinned identity', async t => {
  for (const wrong of [false, true]) {
    let slot;
    await withTransport(t, p => {
      if (p.name === 'cron_list') return success({ crons: [{ ...baseCron, next_run_at: new Date().toISOString() }] });
      if (!p.arguments.job_id) { slot = Date.now(); return success({ jobs: [row('job_real', slot)] }); }
      return success(row(wrong ? 'job_replacement' : 'job_real', slot, 'complete', {
        started_at: new Date(slot + 2).toISOString(), completed_at: new Date(slot + 10).toISOString(), result: { reminded: 3 },
      }));
    }, async env => {
      const out = await run(['--wait-next', '--timeout', '2', ...(wrong ? ['--json'] : [])], env);
      if (wrong) {
        assert.equal(out.status, 1);
        assert.equal(JSON.parse(out.stdout).error, 'CRON_RUN_MISMATCH');
      } else {
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stdout, /Natural scheduled occurrence:.*job job_real/);
        assert.match(out.stdout, /started .*completed /);
        assert.match(out.stdout, /reminded.*3/);
      }
    });
  }
});
