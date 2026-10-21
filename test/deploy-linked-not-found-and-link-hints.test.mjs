import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsk_8a68dfa2 items 14 and 15 (CLI wording only). A folder linked to a
// project the sign-in cannot open is told how to relink, without the CLI
// guessing which of not-found / no-access / expired it was; commands that need
// a project in an unlinked folder name the linking commands. Nothing here
// links, creates, deletes or rewrites a link on its own.
const distIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

let answer = { status: 404, body: { ok: false, error: 'PROJECT_NOT_FOUND', message: 'Project not found.' } };
const requests = [];
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  res.statusCode = answer.status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(answer.body));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function run(args, cwd, configDir) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', SOMEWHERE_API_URL: apiUrl, SOMEWHERE_CONFIG_DIR: configDir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

const account = { token: 'smt_account', user: { email: 'dev@example.com', username: 'dev' } };
const link = { project_id: 'proj_old_temp', name: 'old-temp', subdomain: 'old-temp' };

function fixture({ config, withLink }) {
  const root = mkdtempSync(join(tmpdir(), 'sw-linked-not-found-'));
  const configDir = join(root, 'config');
  const app = join(root, 'app');
  mkdirSync(configDir);
  mkdirSync(app);
  if (config) writeFileSync(join(configDir, 'config.json'), JSON.stringify(config));
  writeFileSync(join(app, 'index.html'), '<html><body>hi</body></html>\n');
  if (withLink) writeFileSync(join(app, '.somewhere.json'), JSON.stringify(link));
  return { app, configDir };
}

const notFound = { status: 404, body: { ok: false, error: 'PROJECT_NOT_FOUND', message: 'Project not found.' } };

test('signed in, linked project not found: keeps the error, names the relink steps, keeps the link file', async () => {
  answer = notFound;
  requests.length = 0;
  const { app, configDir } = fixture({ config: account, withLink: true });
  const before = readFileSync(join(app, '.somewhere.json'), 'utf8');
  const r = await run(['deploy'], app, configDir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /\[PROJECT_NOT_FOUND, HTTP 404\]/);
  assert.match(r.stderr, /linked to project proj_old_temp \(in \.somewhere\.json\), which this sign-in cannot open/);
  assert.match(r.stderr, /Nothing was deployed/);
  assert.match(r.stderr, /`somewhere projects`/);
  assert.match(r.stderr, /`somewhere init --link --project <name-or-id>`/);
  // init refuses an already-linked folder non-interactively, so the stale link is removed first.
  assert.match(r.stderr, /delete this folder's \.somewhere\.json \(your other files are kept\), run `somewhere init --bare --name <name>`/);
  // Possibilities only: it never claims to know the project expired or exists.
  assert.doesNotMatch(r.stderr, /expired at|your temporary project expired|exists but/i);
  assert.doesNotMatch(r.stderr, /somewhere link --project/);
  assert.equal(readFileSync(join(app, '.somewhere.json'), 'utf8'), before, 'the link file is never rewritten');
  assert.ok(!requests.some((x) => x.startsWith('POST /projects')), requests.join(', '));
});

test('signed in, linked project not found, --json: same code plus linked_project_id and next_steps', async () => {
  answer = notFound;
  const { app, configDir } = fixture({ config: account, withLink: true });
  const r = await run(['deploy', '--json'], app, configDir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'PROJECT_NOT_FOUND');
  assert.equal(out.linked_project_id, 'proj_old_temp');
  assert.equal(out.deployed, false);
  assert.ok(Array.isArray(out.next_steps) && out.next_steps.some((s) => s.includes('somewhere init --link --project')), r.stdout);
});

test('--project named by the caller: plain not-found, no link advice', async () => {
  answer = notFound;
  const { app, configDir } = fixture({ config: account, withLink: true });
  const r = await run(['deploy', '--project', 'someone-elses', '--json'], app, configDir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.error, 'PROJECT_NOT_FOUND');
  assert.equal(out.linked_project_id, undefined);
  assert.equal(out.next_steps, undefined);
});

test('--project naming the linked id itself: the caller chose it, so still no link advice', async () => {
  answer = notFound;
  const { app, configDir } = fixture({ config: account, withLink: true });
  const r = await run(['deploy', '--project', 'proj_old_temp', '--json'], app, configDir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.error, 'PROJECT_NOT_FOUND');
  assert.equal(out.next_steps, undefined);
});

test('a different refusal (403) on a linked folder gets no relink advice', async () => {
  answer = { status: 403, body: { ok: false, error: 'FORBIDDEN', message: 'Deploying requires editor access.' } };
  const { app, configDir } = fixture({ config: account, withLink: true });
  const r = await run(['deploy'], app, configDir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /\[FORBIDDEN, HTTP 403\]/);
  assert.doesNotMatch(r.stderr, /init --link|Nothing was deployed|cannot open/);
});

const projectCommands = [
  ['logs'], ['errors'], ['env', 'list'], ['project', 'view'], ['open'], ['verify'],
  ['db', 'query', 'select 1'], ['status'], ['pull'],
];

test('signed in, unlinked: each project command names how to link or create, and sends nothing', async () => {
  answer = { status: 500, body: { ok: false, error: 'UNEXPECTED', message: 'no request expected' } };
  for (const args of projectCommands) {
    requests.length = 0;
    const { app, configDir } = fixture({ config: account, withLink: false });
    const r = await run(args, app, configDir);
    const out = r.stdout + r.stderr;
    assert.notEqual(r.status, 0, `${args.join(' ')}: ${out}`);
    assert.match(out, /somewhere init --link --project <name-or-id>/, args.join(' '));
    assert.match(out, /somewhere init --bare --name <name>/, args.join(' '));
    assert.doesNotMatch(out, /or run `somewhere init`\./, args.join(' '));
    assert.deepEqual(requests, [], `${args.join(' ')} sent ${requests.join(', ')}`);
  }
});

test('logged out, unlinked: sign in comes first and nothing is minted', async () => {
  answer = { status: 500, body: { ok: false, error: 'UNEXPECTED', message: 'no request expected' } };
  for (const args of [['logs'], ['status'], ['env', 'list']]) {
    requests.length = 0;
    const { app, configDir } = fixture({ config: null, withLink: false });
    const r = await run(args, app, configDir);
    const out = r.stdout + r.stderr;
    assert.notEqual(r.status, 0, out);
    // Sign-in is the first step either way; linking advice never comes before it.
    assert.match(out, /somewhere login/, args.join(' '));
    assert.doesNotMatch(out, /init --bare --name/, args.join(' '));
    assert.deepEqual(requests, [], `${args.join(' ')} sent ${requests.join(', ')}`);
  }
});
