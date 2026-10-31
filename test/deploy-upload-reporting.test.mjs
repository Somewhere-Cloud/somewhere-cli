// tsk_1108097a: deploy and check report what they UPLOAD, not what the site
// publishes. tsk_746516 (founder/task decision, superseding the earlier
// upload-everything behaviour): a tests/ or __tests__/ folder is held back by
// default and named as not published; other subfolders such as e2e/ still
// upload. The CLI never claims a subfolder is private, and the platform's own
// warnings about what it keeps private are printed as sent. A server that
// sends no such warning gets no claim from the CLI either way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

const SERVER_WARNING = 'Not published (2 test files): e2e/run.mjs, tests/note.txt. Files inside tests/, e2e/ folders stay in your project\'s private source and are never served on your site.';

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, SOMEWHERE_MCP_URL: 'http://127.0.0.1:1/mcp', ...env, CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr, all: stdout + stderr }));
  });
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function project() {
  const HOME = mkdtempSync(join(tmpdir(), 'sw-upload-report-home-'));
  mkdirSync(join(HOME, '.somewhere'), { recursive: true });
  writeFileSync(join(HOME, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_upload_report', user: { email: 'u@example.com', username: 'u' } }) + '\n');
  const dir = mkdtempSync(join(tmpdir(), 'sw-upload-report-app-'));
  const files = {
    '.somewhere.json': JSON.stringify({ project_id: 'proj_upload_report', name: 'upload-report', subdomain: 'upload-report' }) + '\n',
    'index.html': '<html><body><script type="module" src="/src/main.js"></script></body></html>\n',
    'src/main.js': 'document.body.dataset.ready = "1";\n',
    'tests/note.txt': 'test account notes\n',
    'e2e/run.mjs': 'export const run = 1;\n',
    'NOTES.md': 'agent scratch notes\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return { HOME, dir };
}

/** One fake platform. `warnings` is what this server version says. */
async function withPlatform(warnings, fn) {
  const requests = [];
  const deployData = { files: 4, url: 'https://upload-report.somewhere.site', has_functions: false, build_log: [], warnings };
  const dryRunData = {
    current_version: 3,
    static_files: { added: [], modified: ['index.html'], removed: [], added_count: 0, modified_count: 1, removed_count: 0 },
    functions: null,
    warnings,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, body: parsed });
      if (req.method === 'POST' && req.url === '/v1/deploy') {
        sendJson(res, 200, { ok: true, data: parsed?.dry_run ? dryRunData : deployData });
      } else if (req.method === 'POST' && req.url === '/v1/deploy/check') {
        sendJson(res, 200, { ok: true, data: { ok: true, errors: [], warnings, build_log: [] } });
      } else {
        sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
      }
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`, requests, deployData);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

const uploaded = (request) => Object.keys(request.body.files ?? {}).sort();
const EXPECTED_UPLOAD = ['e2e/run.mjs', 'index.html', 'src/main.js'];

for (const [label, warnings] of [['a server that names private files', [SERVER_WARNING]], ['a server that sends no warning', []]]) {
  test(`deploy with ${label}: uploads subfolders, says "uploaded", and adds no claim of its own`, async () => {
    const { HOME, dir } = project();
    await withPlatform(warnings, async (apiUrl, requests) => {
      const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl };
      const first = await run(['deploy'], { cwd: dir, env });
      assert.equal(first.status, 0, first.all);
      const deploy = requests.find((r) => r.url === '/v1/deploy');
      assert.deepEqual(uploaded(deploy), EXPECTED_UPLOAD, 'e2e/ still uploads; tests/ is held back');
      assert.ok(!('NOTES.md' in deploy.body.files), 'an unreferenced root note is still held back');

      assert.match(first.all, /Not published \(2\): NOTES\.md, tests\/note\.txt/);
      assert.match(first.all, /Every other file in this folder, subfolders included, is uploaded with your app\./);
      assert.doesNotMatch(first.all, /A deploy publishes your app/);
      assert.match(first.all, /3 static files uploaded \(/);
      assert.doesNotMatch(first.all, /static files? deployed/);

      if (warnings.length) {
        assert.equal(first.all.split(SERVER_WARNING).length - 1, 1, 'the server warning is printed once, as sent');
      } else {
        assert.doesNotMatch(first.all, /test files?|kept private|private source|never served/i, 'no inferred claim either way');
      }
      assert.doesNotMatch(first.all, /Published \(/);

      // The once-per-project explanation is remembered; the named list is not.
      const second = await run(['deploy'], { cwd: dir, env });
      assert.equal(second.status, 0, second.all);
      assert.match(second.all, /Not published \(2\): NOTES\.md, tests\/note\.txt/);
      assert.doesNotMatch(second.all, /Every other file in this folder/);
    });
  });
}

test('deploy --json prints only the raw response, warnings included', async () => {
  const { HOME, dir } = project();
  await withPlatform([SERVER_WARNING], async (apiUrl, requests, deployData) => {
    const result = await run(['deploy', '--json'], { cwd: dir, env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl } });
    assert.equal(result.status, 0, result.all);
    assert.deepEqual(JSON.parse(result.stdout), deployData);
    assert.deepEqual(uploaded(requests.find((r) => r.url === '/v1/deploy')), EXPECTED_UPLOAD);
  });
});

test('deploy --dry-run sends the same upload and prints the server warning as sent', async () => {
  const { HOME, dir } = project();
  await withPlatform([SERVER_WARNING], async (apiUrl, requests) => {
    const result = await run(['deploy', '--dry-run'], { cwd: dir, env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl } });
    assert.equal(result.status, 0, result.all);
    const dry = requests.find((r) => r.url === '/v1/deploy');
    assert.equal(dry.body.dry_run, true);
    assert.deepEqual(uploaded(dry), EXPECTED_UPLOAD);
    assert.equal(result.all.split(SERVER_WARNING).length - 1, 1);
    assert.doesNotMatch(result.all, /A deploy publishes your app/);
  });
});

test('deploy-check sends the same upload, names held-back root files truthfully, and passes warnings through', async () => {
  const { HOME, dir } = project();
  await withPlatform([SERVER_WARNING], async (apiUrl, requests) => {
    const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl };
    const human = await run(['deploy-check'], { cwd: dir, env });
    assert.equal(human.status, 0, human.all);
    const check = requests.find((r) => r.url === '/v1/deploy/check');
    assert.deepEqual(uploaded(check), EXPECTED_UPLOAD);
    assert.match(human.all, /Not published \(2\): NOTES\.md, tests\/note\.txt/);
    assert.match(human.all, /subfolders included, is uploaded with your app/);
    assert.doesNotMatch(human.all, /A deploy publishes your app/);
    assert.equal(human.all.split(SERVER_WARNING).length - 1, 1);

    const json = await run(['deploy-check', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.all);
    assert.deepEqual(JSON.parse(json.stdout).warnings, [SERVER_WARNING]);
  });
});


test('non-TTY deploy prints collection once across all preflight warnings and keeps JSON quiet', async () => {
  const { HOME, dir } = project();
  writeFileSync(join(dir, 'server.js'), 'const app = {}; app.listen(3000);\n');
  symlinkSync(join(dir, 'index.html'), join(dir, 'linked.html'));
  await withPlatform([SERVER_WARNING], async (apiUrl, requests, deployData) => {
    const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl };
    const human = await run(['deploy'], { cwd: dir, env });
    assert.equal(human.status, 0, human.all);
    assert.equal(human.stderr.split('Collecting files...').length - 1, 1, human.all);
    assert.match(human.all, /Not published \(2\): NOTES\.md, tests\/note\.txt/);
    assert.match(human.all, /1 file\(s\) will NOT be uploaded/);
    assert.match(human.all, /linked\.html — symlink \(not followed\)/);
    assert.match(human.all, /This looks like a Node server app/);
    assert.match(human.all, /server source will be publicly readable/);
    assert.equal(human.all.split(SERVER_WARNING).length - 1, 1);
    const deploy = requests.find((r) => r.url === '/v1/deploy');
    assert.ok(!('NOTES.md' in deploy.body.files));
    assert.ok(!('linked.html' in deploy.body.files));
    assert.ok('server.js' in deploy.body.files);

    const json = await run(['deploy', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.all);
    assert.deepEqual(JSON.parse(json.stdout), deployData);
    // No progress or preflight prose; only the local omissions, one line each by
    // path and reason, so a --json caller still learns what stayed local (pfb_b141efbfc449).
    assert.deepEqual(json.stderr.trim().split('\n').map((line) => line.split(' — ')[0]),
      ['not published: NOTES.md', 'not published: tests/note.txt', 'not uploaded: linked.html'], json.all);
  });
});
