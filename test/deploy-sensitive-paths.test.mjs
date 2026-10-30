import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Files the sensitive-path policy names never leave the machine (consumer review of
// 0.38.4, pfb_8991bd81d349, pfb_1bc48b5a24ae, pfb_856072304b0c). The deploy API
// refuses these paths in any folder (worker/src/utils/deploy-paths.ts, vendored
// byte-identical); the CLI now applies the same policy while collecting, before
// any file is read into an upload and before any request. No opt-in reopens it.
// When published source names such a file, the command refuses with nothing
// sent: a filename match, not import analysis, so docs (.md) are never
// consulted and a code comment that names the file refuses with an escape.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { collectFiles, sensitiveReferenceRefusal, SENSITIVE_FILE_REASON } = await import(pathToFileURL(join(root, 'dist/lib/files.js')).href);
const { isSensitiveDeployPath } = await import(pathToFileURL(join(root, 'dist/lib/vendor/deploy-paths.js')).href);
const distIndex = join(root, 'dist', 'index.js');

const CANARY = 'cnry_sensitive_never_sent_7f3a';
function app(files) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-sensitive-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
const uploaded = (c) => [...Object.keys(c.files), ...Object.keys(c.binaryFiles), ...Object.keys(c.functions)].sort();
const sensitivePaths = (c) => c.sensitive.map((e) => e.path);

const BASE = {
  'index.html': '<html><body><script type="module" src="/src/main.tsx"></script></body></html>\n',
  'src/main.tsx': 'import "./App";\n',
  'src/App.tsx': 'export const App = 1;\n',
  'package.json': '{"name":"a","private":true}\n',
  'api/hello.ts': 'export default async () => new Response("ok");\n',
};
const SECRETS = {
  'certs/server.key': `${CANARY} key\n`,
  'keys/prod.pem': `${CANARY} pem\n`,
  'config/credentials.json': `{"k":"${CANARY}"}\n`,
  'id_rsa': `${CANARY} rsa\n`,
  'service-account.json': `{"private_key":"${CANARY}"}\n`,
  'nested/deep/secrets.json': `{"k":"${CANARY}"}\n`,
  'credentials/prod.txt': `${CANARY}\n`,
  'certs/client.p12': `${CANARY}\n`,
};
// Legitimate files whose names resemble the policy's words.
const LEGIT = {
  'credentials.ts': 'export const credentialsForm = 1;\n',
  'src/components/credentials.tsx': 'export const Credentials = () => null;\n',
  'docs/credentials.md': '# Credentials\n',
  'public/credentials-help.html': '<p>help</p>\n',
  '.well-known/security.txt': 'Contact: mailto:security@example.com\n',
  'public/.well-known/assetlinks.json': '[]\n',
  'src/keys.ts': 'export const keys = 1;\n',
  'src/key-value.ts': 'export const kv = 1;\n',
  'api/secret-santa.ts': 'export default async () => new Response("[]");\n',
  'src/pem-viewer.tsx': 'export const PemViewer = 1;\n',
  'config/firebase.json': '{"hosting":{}}\n',
  'config/app.json': '{"theme":"dark"}\n',
};

test('FIRES: credentials and private-key files in any folder are held back, never uploaded, never read', () => {
  const dir = app({ ...BASE, ...SECRETS, ...LEGIT });
  chmodSync(join(dir, 'certs/server.key'), 0o000); // unreadable: proof it is never read
  try {
    const c = collectFiles(dir);
    assert.deepEqual(sensitivePaths(c), Object.keys(SECRETS).sort((a, b) => a.localeCompare(b)));
    for (const path of Object.keys(SECRETS)) assert.ok(!uploaded(c).includes(path), `${path} is not uploaded`);
    for (const entry of c.sensitive) assert.equal(entry.reason, SENSITIVE_FILE_REASON);
    assert.ok(!c.excluded.some((e) => e.path in SECRETS), 'not offered as an --include-able not-published file');
    assert.doesNotMatch(JSON.stringify(c), new RegExp(CANARY), 'no secret byte enters the collection');
    assert.equal(sensitiveReferenceRefusal(c), null, 'nothing names them: no refusal, the deploy proceeds without them');
  } finally {
    chmodSync(join(dir, 'certs/server.key'), 0o600);
  }
});

test('LEGITIMATE: credentials.ts/tsx/md, .well-known, keys.ts, secret-santa.ts, firebase.json and other config still upload', () => {
  const c = collectFiles(app({ ...BASE, ...LEGIT }));
  assert.deepEqual(c.sensitive, []);
  const up = uploaded(c);
  for (const path of ['credentials.ts', 'src/components/credentials.tsx', 'docs/credentials.md', '.well-known/security.txt',
    'src/keys.ts', 'src/key-value.ts', 'api/secret-santa.ts', 'src/pem-viewer.tsx', 'config/firebase.json', 'config/app.json']) {
    assert.ok(up.includes(path), `${path} uploads`);
  }
  assert.ok(up.some((p) => p.endsWith('.well-known/assetlinks.json')), 'public/.well-known uploads');
  assert.ok(up.some((p) => p.endsWith('credentials-help.html')), 'a page about credentials uploads');
});

test('no opt-in reopens them: --include, "!" lines in .somewhereignore and .gitignore', () => {
  const dir = app({
    ...BASE, ...SECRETS,
    '.somewhereignore': '!id_rsa\n!service-account.json\n!certs/\n!keys/prod.pem\n',
    '.gitignore': '!config/credentials.json\n',
  });
  const c = collectFiles(dir, { include: [...Object.keys(SECRETS), 'certs', 'keys'] });
  assert.deepEqual(sensitivePaths(c), Object.keys(SECRETS).sort((a, b) => a.localeCompare(b)));
  for (const path of Object.keys(SECRETS)) assert.ok(!uploaded(c).includes(path), `${path} stays home despite the opt-ins`);
});

test('the collector applies exactly the vendored deploy-path policy to every file it would send', () => {
  const c = collectFiles(app({ ...BASE, ...SECRETS, ...LEGIT }));
  for (const path of uploaded(c)) assert.equal(isSensitiveDeployPath(path), false, `${path} passes the API's policy`);
  for (const path of sensitivePaths(c)) assert.equal(isSensitiveDeployPath(path), true, `${path} is what the API refuses`);
  const manifest = JSON.parse(readFileSync(join(root, 'src/lib/vendor/DEPLOY-PATHS-VENDOR.json'), 'utf8'));
  const text = readFileSync(join(root, 'src/lib/vendor/deploy-paths.ts'), 'utf8');
  assert.equal(manifest.source, 'worker/src/utils/deploy-paths.ts');
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  assert.equal(createHash('sha256').update(text).digest('hex'), manifest.sha256, 'the vendored copy matches its manifest');
  assert.doesNotMatch(text, /^import /m, 'the policy module has no imports');
});

test('source that names a held-back secret refuses with sw.env guidance, paths only, no bytes', () => {
  const c = collectFiles(app({
    ...BASE, ...SECRETS,
    'api/hello.ts': 'import key from "../service-account.json";\nexport default async () => Response.json({ ok: !!key });\n',
  }));
  assert.deepEqual(c.sensitive.find((e) => e.path === 'service-account.json').referencedBy, ['api/hello.ts']);
  assert.ok(!uploaded(c).includes('service-account.json'));
  const message = sensitiveReferenceRefusal(c);
  assert.match(message, /^Nothing was sent\./);
  assert.match(message, /api\/hello\.ts mentions service-account\.json/);
  assert.match(message, /filename match in your source, not an import analysis/);
  assert.match(message, /somewhere env set SERVICE_ACCOUNT_JSON --stdin < service-account\.json/);
  assert.match(message, /sw\.env\.SERVICE_ACCOUNT_JSON/);
  assert.doesNotMatch(message, new RegExp(CANARY));
});

test('a docs mention does not refuse; a code comment that names the file refuses, and ignoring the file is the escape', () => {
  const docsOnly = collectFiles(app({
    ...BASE, ...SECRETS,
    'README.md': 'Download service-account.json and keys/prod.pem from the console.\n',
    'docs/setup.md': 'Put credentials.json in config/.\n',
  }));
  assert.equal(sensitiveReferenceRefusal(docsOnly), null, 'documentation is never consulted');
  assert.ok(!uploaded(docsOnly).includes('service-account.json'));

  const comment = { 'src/firebase.ts': '// Locally: download service-account.json from the console.\nexport const app = 1;\n' };
  const mentioned = collectFiles(app({ ...BASE, ...SECRETS, ...comment }));
  const message = sensitiveReferenceRefusal(mentioned);
  assert.match(message, /src\/firebase\.ts mentions service-account\.json/, 'conservative: a mention in published code refuses');
  assert.match(message, /If nothing loads it .* add it to \.somewhereignore or move it out of this folder/);
  const ignored = collectFiles(app({ ...BASE, ...SECRETS, ...comment, '.somewhereignore': 'service-account.json\n' }));
  assert.equal(sensitiveReferenceRefusal(ignored), null);
  assert.ok(!sensitivePaths(ignored).includes('service-account.json'), 'an ignored file is not collected at all');
});

// ── The commands: refusal before any request; dry-run disclosure ───────────
const requests = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
    requests.push({ method: req.method, url: req.url, body: parsed, raw: body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v1/deploy' && parsed?.dry_run === true) {
      res.end(JSON.stringify({ ok: true, data: { current_version: 3, static_files: { added: [], modified: ['index.html'], removed: [], added_count: 0, modified_count: 1, removed_count: 0 }, functions: null } }));
      return;
    }
    if (req.method === 'GET' && req.url.includes('/notices')) {
      res.end(JSON.stringify({ ok: true, data: { notices: [] } }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: 'UNEXPECTED', message: `${req.method} ${req.url}` }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}/v1`;
test.after(() => server.close());

function run(args, cwd, configDir) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [distIndex, ...args], {
      cwd,
      env: { ...process.env, SOMEWHERE_API_URL: apiUrl, SOMEWHERE_CONFIG_DIR: configDir, SOMEWHERE_MCP_URL: 'http://127.0.0.1:1/mcp', CI: '1', SOMEWHERE_NO_NOTIFICATIONS: '1', SOMEWHERE_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolvePromise({ status, stdout, stderr, all: stdout + stderr }));
  });
}
const signedIn = { token: 'smt_account', user: { email: 'u@example.com', username: 'u' } };
const link = { project_id: 'proj_linked', name: 'linked', subdomain: 'linked' };
function project(files, { config, linked } = {}) {
  const dir = app(files);
  const configDir = mkdtempSync(join(tmpdir(), 'sw-sensitive-config-'));
  if (config) writeFileSync(join(configDir, 'config.json'), JSON.stringify(config));
  if (linked) writeFileSync(join(dir, '.somewhere.json'), JSON.stringify(link));
  return { dir, configDir };
}
const IMPORTED = { ...BASE, ...SECRETS, 'api/hello.ts': 'import key from "../service-account.json";\nexport default async () => Response.json({ ok: !!key });\n' };

for (const [label, args, setup] of [
  ['deploy, signed in and linked', ['deploy'], { config: signedIn, linked: true }],
  ['deploy --dry-run, signed in and linked', ['deploy', '--dry-run'], { config: signedIn, linked: true }],
  ['deploy, signed out (no proof-of-work, no temporary workspace)', ['deploy'], {}],
  ['deploy-check, signed in and linked', ['deploy-check'], { config: signedIn, linked: true }],
]) {
  test(`${label}: a referenced secret refuses before any request`, async () => {
    requests.length = 0;
    const fx = project(IMPORTED, setup);
    const r = await run(args, fx.dir, fx.configDir);
    assert.equal(r.status, 1, r.all);
    assert.deepEqual(requests, [], 'no request reaches the platform');
    assert.match(r.all, /Nothing was sent\. Your source references a file blocked by the sensitive-path policy/);
    assert.doesNotMatch(r.all, new RegExp(CANARY));
  });
}

test('deploy --json: the refusal is structured', async () => {
  requests.length = 0;
  const fx = project(IMPORTED, { config: signedIn, linked: true });
  const r = await run(['deploy', '--json'], fx.dir, fx.configDir);
  assert.equal(r.status, 1, r.all);
  assert.deepEqual(requests, []);
  assert.equal(JSON.parse(r.stdout).error, 'SENSITIVE_FILE_REFERENCED');
});

test('deploy-check before a project: the local source check fails on a referenced secret and lists held-back ones', async () => {
  requests.length = 0;
  const fx = project(IMPORTED);
  const r = await run(['deploy-check', '--json'], fx.dir, fx.configDir);
  assert.deepEqual(requests, []);
  const out = JSON.parse(r.stdout);
  const source = out.checks.find((s) => s.name === 'source');
  assert.equal(source.status, 'failed');
  assert.match(source.reason, /service-account\.json/);
  for (const path of Object.keys(SECRETS)) assert.ok(source.not_uploaded.some((e) => e.path === path), `${path} listed as not uploaded`);
  assert.doesNotMatch(r.all, new RegExp(CANARY));
});

test('deploy --dry-run keeps the remote diff, discloses the upload, and sends no held-back secret', async () => {
  requests.length = 0;
  const fx = project({ ...BASE, ...SECRETS, ...LEGIT }, { config: signedIn, linked: true });
  const r = await run(['deploy', '--dry-run'], fx.dir, fx.configDir);
  assert.equal(r.status, 0, r.all);
  const deploys = requests.filter((q) => q.url === '/v1/deploy');
  assert.equal(deploys.length, 1);
  assert.equal(deploys[0].body.dry_run, true, 'the dry run is still computed by the platform');
  assert.match(r.all, /Dry run: sending \d+ files \(.+\) to Somewhere to compute the change\. Nothing is published\./);
  assert.match(r.all, /Never uploaded \(8\): /);
  assert.match(r.all, /Files blocked by the sensitive-path policy stay on your machine/);
  assert.match(r.all, /matches file names only: a secret under any other name uploads like any other file/);
  assert.doesNotMatch(deploys[0].raw, new RegExp(CANARY), 'no secret byte in the request');
  const sent = [...Object.keys(deploys[0].body.files), ...Object.keys(deploys[0].body.functions ?? {}), ...Object.keys(deploys[0].body.binary_files ?? {})];
  for (const path of Object.keys(SECRETS)) assert.ok(!sent.includes(path), `${path} not sent`);
  assert.ok(sent.includes('credentials.ts') && sent.includes('.well-known/security.txt'), 'legitimate look-alikes are sent');
});

test('deploy --help discloses that a dry run sends the source', async () => {
  const fx = project(BASE);
  const r = await run(['deploy', '--help'], fx.dir, fx.configDir);
  assert.match(r.stdout.replace(/\s+/g, ' '), /The files a deploy would publish are sent to Somewhere to compute the change; nothing is published\./);
});
