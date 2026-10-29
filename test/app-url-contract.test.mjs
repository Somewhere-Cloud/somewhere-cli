// App-URL contract: the CLI records `app_url` only from the platform's own
// answers (GET /projects/:ref/urls, deploy `url`) and never builds a host from a
// slug. Two owners can each have slug "shared"; subdomains are globally unique.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fallbackProjectServingUrl, httpsOrigin } from '../dist/lib/project-urls.js';
import { createFeatureTemplate } from '../dist/lib/init-feature-template.js';
import { resolveInitSelection } from '../dist/lib/init-features.js';
import { createHappyPathTemplate } from '../dist/lib/init-template.js';
import { createGreenTemplate } from '../dist/lib/init-green-template.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.js');

function run(args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, SOMEWHERE_MCP_URL: 'http://127.0.0.1:1/mcp', ...env, CI: '1', NO_COLOR: '1', SOMEWHERE_NO_NOTIFICATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-app-url-home-'));
  mkdirSync(join(dir, '.somewhere'), { recursive: true });
  writeFileSync(join(dir, '.somewhere', 'config.json'), JSON.stringify({ token: 'smt_app_url_test', user: { email: 'a@example.com', username: 'a' } }) + '\n');
  return dir;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function withApi(routes, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const key = `${req.method} ${req.url.split('?')[0]}`;
      seen.push(key);
      const route = routes[key];
      if (!route) return sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: req.url });
      const [status, payload] = route(body);
      sendJson(res, status, payload);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`, seen);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const OWNER_A = { id: 'proj_shared_a', name: 'Shared', slug: 'shared', subdomain: 'shared-x7q2' };
const OWNER_B = { id: 'proj_shared_b', name: 'Shared', slug: 'shared', subdomain: 'shared-m4k9' };
const urlsFor = (p, prod = null) => () => [200, { ok: true, data: { prod, prod_fallback: `https://${p.subdomain}.somewhere.site` } }];
const linkFile = (dir) => JSON.parse(readFileSync(join(dir, '.somewhere.json'), 'utf8'));

test('fallback display URL uses only the global subdomain; a slug is never a host', () => {
  assert.equal(fallbackProjectServingUrl({ slug: 'shared', subdomain: 'shared-x7q2' }), 'https://shared-x7q2.somewhere.site');
  assert.equal(fallbackProjectServingUrl({ slug: 'shared' }), null);
  assert.equal(httpsOrigin('https://app.customer.example/some/path'), 'https://app.customer.example');
  assert.equal(httpsOrigin('http://shared.somewhere.site'), null);
  assert.equal(httpsOrigin('https://user:pw@shared.somewhere.site'), null);
});

test('every starter calls its own backend same-origin: no SDK host, no invoke, no absolute app host', () => {
  const combos = [['auth', 'styled'], ['auth', 'headless'], ['auth,private-data', 'styled'], ['auth,private-data', 'headless'],
    ['agent', 'styled'], ['agent', 'headless'], ['auth,private-data,agent', 'styled'],
    ['magic-link', 'styled'], ['magic-link', 'headless'], ['magic-link,private-data', 'styled']];
  const starters = [
    ['happy-path', createHappyPathTemplate()],
    ['green', createGreenTemplate()],
    ...combos.map(([features, ui]) => [`${features}/${ui}`, createFeatureTemplate(resolveInitSelection(features, ui), { appName: 'Shared' })]),
  ];
  for (const [label, files] of starters) {
    const code = files.filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f.path));
    assert.ok(code.length > 0, label);
    for (const { path, content } of code) {
      assert.doesNotMatch(content, /new Somewhere\(|createClient\(|functions\.invoke\(|\.rpc\(/, `${label} ${path}: no explicit SDK client host`);
      assert.doesNotMatch(content, /https?:\/\/[a-z0-9.-]*somewhere\.(?:site|tech|cloud)/i, `${label} ${path}: no absolute app host`);
      assert.doesNotMatch(content, /baseUrl\s*:/, `${label} ${path}: auth client stays same-origin`);
    }
  }
});

test('init records the platform-reported app URL, not one built from the name or slug', async () => {
  const HOME = home();
  const dir = mkdtempSync(join(tmpdir(), 'sw-app-url-init-'));
  await withApi({
    'POST /v1/projects': () => [200, { ok: true, data: OWNER_A }],
    'GET /v1/projects/proj_shared_a/urls': urlsFor(OWNER_A),
  }, async (apiUrl) => {
    const result = await run(['init', '--name', 'Shared', '--bare', '--json'], { cwd: dir, env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).app_url, 'https://shared-x7q2.somewhere.site');
    assert.equal(linkFile(dir).app_url, 'https://shared-x7q2.somewhere.site');
    assert.doesNotMatch(readFileSync(join(dir, '.somewhere.json'), 'utf8'), /\/\/shared\.somewhere/);
  });
});

test('init with no reported URL records none and says so in JSON', async () => {
  const HOME = home();
  const dir = mkdtempSync(join(tmpdir(), 'sw-app-url-init-missing-'));
  await withApi({
    'POST /v1/projects': () => [200, { ok: true, data: OWNER_A }],
    'GET /v1/projects/proj_shared_a/urls': () => [503, { ok: false, error: 'UNAVAILABLE', message: 'fixture' }],
  }, async (apiUrl) => {
    const result = await run(['init', '--name', 'Shared', '--bare', '--json'], { cwd: dir, env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).app_url, null);
    assert.equal('app_url' in linkFile(dir), false);
  });
});

test('link: a duplicate user-scoped slug is ambiguous; the exact id links that project\'s own URL', async () => {
  const HOME = home();
  const dir = mkdtempSync(join(tmpdir(), 'sw-app-url-link-'));
  await withApi({
    'GET /v1/projects': () => [200, { ok: true, data: { projects: [OWNER_A, OWNER_B] } }],
    'GET /v1/projects/proj_shared_b/urls': urlsFor(OWNER_B),
  }, async (apiUrl, seen) => {
    const env = { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl };
    const ambiguous = await run(['init', '--link', '--project', 'shared', '--json'], { cwd: dir, env });
    assert.notEqual(ambiguous.status, 0);
    assert.match(JSON.parse(ambiguous.stdout).message, /Multiple projects match "shared"\. Pass the project ID instead\./);
    assert.equal(seen.some((s) => s.endsWith('/urls')), false, 'no URL is read for an ambiguous slug');
    const exact = await run(['init', '--link', '--project', OWNER_B.id, '--json'], { cwd: dir, env });
    assert.equal(exact.status, 0, exact.stderr);
    assert.equal(JSON.parse(exact.stdout).app_url, 'https://shared-m4k9.somewhere.site');
    assert.equal(linkFile(dir).app_url, 'https://shared-m4k9.somewhere.site');
  });
});

test('existing link without app_url: status --json reports the authoritative URL, custom domain first', async () => {
  const HOME = home();
  const dir = mkdtempSync(join(tmpdir(), 'sw-app-url-status-'));
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: OWNER_B.id, name: 'Shared', subdomain: OWNER_B.subdomain }) + '\n');
  await withApi({
    [`GET /v1/projects/${OWNER_B.id}`]: () => [200, { ok: true, data: { ...OWNER_B, status: 'deployed' } }],
    [`GET /v1/projects/${OWNER_B.id}/urls`]: urlsFor(OWNER_B, 'https://app.customer.example'),
  }, async (apiUrl) => {
    const result = await run(['status', '--json'], { cwd: dir, env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl } });
    const body = JSON.parse(result.stdout);
    assert.equal(body.app_url, 'https://app.customer.example');
    assert.equal(body.app_url_error, null);
  });
  await withApi({
    [`GET /v1/projects/${OWNER_B.id}`]: () => [200, { ok: true, data: { ...OWNER_B, status: 'deployed' } }],
  }, async (apiUrl) => {
    const result = await run(['status', '--json'], { cwd: dir, env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl } });
    const body = JSON.parse(result.stdout);
    assert.equal(body.app_url, null, 'no URL is guessed when the platform does not answer');
    assert.equal(body.app_url_error.code, 'APP_URL_UNAVAILABLE');
  });
});

test('deploy refreshes app_url from the platform\'s live URL for the linked project only', async () => {
  const HOME = home();
  const dir = mkdtempSync(join(tmpdir(), 'sw-app-url-deploy-'));
  writeFileSync(join(dir, '.somewhere.json'), JSON.stringify({ project_id: OWNER_B.id, name: 'Shared', subdomain: OWNER_B.subdomain }) + '\n');
  writeFileSync(join(dir, 'index.html'), '<html><body>shared</body></html>\n');
  await withApi({
    'POST /v1/deploy': () => [200, { ok: true, data: { project_id: OWNER_B.id, version: 3, files: 1, url: 'https://shared-m4k9.somewhere.site', has_functions: false } }],
  }, async (apiUrl) => {
    const result = await run(['deploy'], { cwd: dir, env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl } });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(linkFile(dir).app_url, 'https://shared-m4k9.somewhere.site');
  });
  await withApi({
    'POST /v1/deploy': () => [200, { ok: true, data: { project_id: 'proj_someone_else', version: 1, files: 1, url: 'https://elsewhere.somewhere.site', has_functions: false } }],
  }, async (apiUrl) => {
    await run(['deploy'], { cwd: dir, env: { HOME, USERPROFILE: HOME, SOMEWHERE_API_URL: apiUrl } });
    assert.equal(linkFile(dir).app_url, 'https://shared-m4k9.somewhere.site', 'a URL for another project is never recorded');
  });
});
