// The after-live reference check runs in the background, so a deploy can only
// answer `reference_check: { status: 'pending' }`. Text output names the
// existing read that carries the result — the deploy log for this exact
// version — instead of leaving the user with no way to see it
// (tsk_8a68dfa2 item 4). Both directions:
//   - pending → one hint whose JSON `call` resolves to the deployed project;
//   - checked / absent / no version → no hint; --json output is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatReferenceCheckHint, readSettledReferenceCheck, REFERENCE_CHECK_READ_DELAYS_MS } from '../dist/commands/deploy.js';
import { chooseCallScope } from '../dist/commands/call.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');
const PROJECT = 'proj_refcheck_hint';
const deployLogTool = { name: 'project_deploy_log', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, version: { type: 'number' } } } };

const hintJson = (hint) => JSON.parse(hint.slice(hint.indexOf("'") + 1, hint.lastIndexOf("'")));

test('pending: the hint names the deploy log for this version; linked folder omits project_id', () => {
  const hint = formatReferenceCheckHint({ project_id: PROJECT, version: 3, has_functions: true, reference_check: { status: 'pending' } }, true);
  assert.match(hint, /somewhere call project_deploy_log '\{"version":3\}'/);
  const scope = chooseCallScope(hintJson(hint), { project_id: PROJECT, name: 'r' }, false, deployLogTool);
  assert.equal(scope.kind, 'linked');
  assert.equal(scope.args.project_id, PROJECT, 'call resolves to the deployed project');
});

test('pending from a folder not linked to that project: the hint names the project explicitly', () => {
  const hint = formatReferenceCheckHint({ project_id: PROJECT, version: 4, has_functions: false, reference_check: { status: 'pending' } }, false);
  assert.deepEqual(hintJson(hint), { project_id: PROJECT, version: 4 });
  // Run from a folder linked to ANOTHER project: explicit project_id still wins.
  assert.equal(chooseCallScope(hintJson(hint), { project_id: 'proj_other' }, false, deployLogTool).kind, 'explicit');
});

test('no hint when the check is not pending or the answer cannot name a version/project', () => {
  for (const result of [
    { project_id: PROJECT, version: 3, has_functions: true, reference_check: { status: 'checked' } },
    { project_id: PROJECT, version: 3, has_functions: true },
    { project_id: PROJECT, version: 3, has_functions: true, reference_check: null },
    { project_id: PROJECT, has_functions: true, reference_check: { status: 'pending' } },
  ]) assert.equal(formatReferenceCheckHint(result, true), null);
  assert.equal(formatReferenceCheckHint({ version: 3, has_functions: true, reference_check: { status: 'pending' } }, false), null);
});

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], { cwd, env: { ...process.env, ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}
const sendJson = (res, status, payload) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); };

async function deploy(referenceCheck, extraArgs = [], deployLog = null) {
  const home = mkdtempSync(join(tmpdir(), 'sw-refcheck-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-refcheck-fixture-'));
  mkdirSync(join(home, '.somewhere'), { recursive: true });
  writeFileSync(join(home, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_refcheck', user: { email: 'dev@example.com', username: 'dev' } }) + '\n');
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: PROJECT, name: 'r', subdomain: 'refcheck-app', source_base: { release_id: 'rel_2' } }) + '\n');
  writeFileSync(join(dir, 'index.html'), '<html><body>refcheck</body></html>\n');
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && path === `/v1/projects/${PROJECT}/notices`) return sendJson(res, 200, { ok: true, data: { project_id: PROJECT, notices: [] } });
      if (req.method === 'GET' && path === '/v1/deploy/log' && deployLog) return sendJson(res, 200, { ok: true, data: deployLog });
      if (req.method === 'POST' && path === '/v1/deploy') {
        return sendJson(res, 200, { ok: true, data: {
          project_id: PROJECT, url: 'https://refcheck-app.somewhere.site', version: 3, release_id: 'rel_3', active_release_id: 'rel_3',
          files_deployed: 1, has_functions: false, warnings: [], status: 'success', release_publish: true,
          ...(referenceCheck ? { reference_check: referenceCheck } : {}),
        } });
      }
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await run(['deploy', '--yes', ...extraArgs], {
      cwd: dir,
      env: { HOME: home, USERPROFILE: home, SOMEWHERE_API_URL: `http://127.0.0.1:${port}/v1` },
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

test('a real deploy with a pending check prints the hint once', async () => {
  const r = await deploy({ status: 'pending', requested_at: '2026-10-21T19:49:09.699Z' });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.equal(out.match(/somewhere call project_deploy_log '\{"version":3\}'/g)?.length, 1, out);
});

test('a real deploy without a pending check prints no hint', async () => {
  const r = await deploy(null);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /project_deploy_log/);
});

test('--json output is unchanged: reference_check passes through, no hint text', async () => {
  const r = await deploy({ status: 'pending', requested_at: '2026-10-21T19:49:09.699Z' }, ['--json']);
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(json.reference_check.status, 'pending');
  assert.doesNotMatch(r.stdout, /A reference check is running/);
});

// pfb_e477b6f2c280: the dry run prints the reference check's lines inline, so
// the deploy prints them too once its after-live check settles.
const TS_LINE = 'Type warning (TS2345) at api/seed.ts:3:7: Argument of type \'number\' is not assignable to parameter of type \'string\'. This finding will not block deploy, but it may break at runtime; a fix takes effect on the next deploy.';
const pending = { project_id: PROJECT, version: 3, reference_check: { status: 'pending' } };

test('settled check: reads the log until it settles and returns its lines', async () => {
  const answers = [{ reference_check: { status: 'pending' } }, { warnings: [TS_LINE], reference_check: { status: 'checked', findings: 1 } }];
  const reads = []; const waits = [];
  const settled = await readSettledReferenceCheck(async (q) => { reads.push(q); return answers.shift(); }, pending, async (ms) => { waits.push(ms); });
  assert.deepEqual(settled, { warnings: [TS_LINE] });
  assert.deepEqual(reads, [{ project_id: PROJECT, version: 3 }, { project_id: PROJECT, version: 3 }]);
  assert.deepEqual(waits, REFERENCE_CHECK_READ_DELAYS_MS.slice(0, 2));
});

test('still pending, unreadable, unavailable, or nothing pending: null, so the hint prints', async () => {
  let reads = 0;
  assert.equal(await readSettledReferenceCheck(async () => { reads++; return { reference_check: { status: 'pending' } }; }, pending, async () => {}), null);
  assert.equal(reads, REFERENCE_CHECK_READ_DELAYS_MS.length, 'bounded: one read per delay');
  assert.equal(await readSettledReferenceCheck(async () => { throw new Error('offline'); }, pending, async () => {}), null);
  assert.equal(await readSettledReferenceCheck(async () => assert.fail('no read'), { ...pending, reference_check: { status: 'checked' } }, async () => {}), null);
  let unavailableReads = 0;
  assert.equal(await readSettledReferenceCheck(async () => { unavailableReads++; return { reference_check: { status: 'unavailable' } }; }, pending, async () => {}), null);
  assert.equal(unavailableReads, 1, 'unavailable is final: no further reads');
});

test('a real deploy prints the settled check\'s lines instead of the hint', async () => {
  const r = await deploy({ status: 'pending', requested_at: '2026-10-31T19:49:09.699Z' }, [], { version: 3, warnings: [TS_LINE], reference_check: { status: 'checked', findings: 1 } });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.equal(out.split(TS_LINE).length - 1, 1, out);
  assert.doesNotMatch(out, /project_deploy_log/);
});
