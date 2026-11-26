// The CLI knows when it is out of date: its vendored platform bundle carries the
// consumer contract it implements; every platform response announces the platform's; typecheck
// and lint keep checking against the bundled rules. An older CLI offers an upgrade on commands
// where the contract matters. A loopback server stands in for the platform here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configDir = mkdtempSync(join(tmpdir(), 'sw-contract-config-'));
process.env.SOMEWHERE_CONFIG_DIR = configDir;
process.env.SOMEWHERE_API_URL = 'https://api.example.test';
const require = createRequire(import.meta.url);
const vendor = require('../runtime/declared-data.cjs');
const lintVendor = require('../runtime/source-lint.cjs');
const { recordPlatformContract, platformContractVerdict, cliConsumerContract } = await import('../dist/lib/platform-contract.js');
const { fetchWithProxy } = await import('../dist/lib/http.js');
const { runTypecheck } = await import('../dist/lib/typecheck.js');
const { lintProject } = await import('../dist/lib/source-lint.js');

const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const seenFile = join(configDir, 'platform-contract.json');
const CLI = cliConsumerContract();
const header = (version, digest) => new Headers({ 'x-sw-consumer-contract': `${version}; digest=${digest}` });
const reset = () => writeFileSync(seenFile, JSON.stringify({ origins: {} }));

function project(schema) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-contract-project-'));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true, lib: ['ES2022', 'DOM'] }, include: ['api', 'db'] }));
  mkdirSync(join(dir, 'api'));
  writeFileSync(join(dir, 'api/hello.ts'), 'export default async function (req: Request, sw: SomewhereRuntimeContext): Promise<Response> {\n  return Response.json({ project: sw.project_id, url: req.url });\n}\n');
  if (schema) { mkdirSync(join(dir, 'db')); writeFileSync(join(dir, 'db/schema.ts'), schema); }
  return dir;
}

test('the vendored bundle carries the consumer contract it actually implements', () => {
  assert.ok(CLI && Number.isInteger(CLI.version) && /^[0-9a-f]{64}$/.test(CLI.digest), JSON.stringify(CLI));
  const components = vendor.consumerContractComponents(vendor, lintVendor.SOURCE_LINT_VERSION, sha256, readFileSync(new URL('../runtime/source-lint.cjs', import.meta.url), 'utf8').replace(/^.*\n/, ''));
  assert.equal(sha256(vendor.consumerContractFingerprint(components)), CLI.digest, 'the recorded digest is the fingerprint of these vendored bytes');
});

test('nothing recorded: unknown, stated, and the check still runs', async () => {
  reset();
  const verdict = platformContractVerdict('https://api.example.test');
  assert.equal(verdict.status, 'unknown');
  assert.equal(verdict.compatible, null);
  const result = await runTypecheck(project());
  assert.equal(result.contract.status, 'unknown');
  assert.equal(result.ok, true, result.raw);
});

test('a platform response records its contract (real fetchWithProxy, loopback platform)', async () => {
  reset();
  const server = createServer((req, res) => { res.setHeader('X-SW-Consumer-Contract', `${CLI.version}; digest=${CLI.digest}`); res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await (await fetchWithProxy(`${base}/v1/projects`)).text(); } finally { server.close(); }
  const recorded = JSON.parse(readFileSync(seenFile, 'utf8')).origins[base];
  assert.equal(recorded.digest, CLI.digest);
  assert.equal(platformContractVerdict(base).status, 'current');
  // A response without the header (npm, third parties) records nothing.
  const quiet = createServer((req, res) => res.end('{}'));
  await new Promise((r) => quiet.listen(0, '127.0.0.1', r));
  const other = `http://127.0.0.1:${quiet.address().port}`;
  try { await (await fetchWithProxy(`${other}/`)).text(); } finally { quiet.close(); }
  assert.equal(JSON.parse(readFileSync(seenFile, 'utf8')).origins[other], undefined);
});

test('same contract: current; the typecheck verdict is its own', async () => {
  reset();
  recordPlatformContract(header(CLI.version, CLI.digest), 'https://api.example.test/v1/me');
  const result = await runTypecheck(project());
  assert.equal(result.contract.status, 'current');
  assert.equal(result.ok, true, result.raw);
});

test('a newer platform contract: real typecheck and lint results remain successful', async () => {
  reset();
  recordPlatformContract(header(CLI.version + 1, 'b'.repeat(64)), 'https://api.example.test/v1/me');
  const result = await runTypecheck(project());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  const lint = await lintProject(project());
  assert.equal(lint.ok, true);
  assert.equal(lint.contract.status, 'outdated');
});

test('a schema refusal still fails when the contract differs', async () => {
  reset();
  recordPlatformContract(header(CLI.version + 1, 'b'.repeat(64)), 'https://api.example.test/v1/me');
  const result = await runTypecheck(project("import { schema, table, id, text, owner, grant } from 'somewhere/db';\nexport default schema({ notes: table({ id: id(), t: text() }, { scope: grant({ table: 'x', grantee: 'y', operations: ['read'] }) }) });\n"));
  assert.deepEqual(result.errors.map((e) => e.code), ['SCHEMA_DECLARATION_INVALID']);
});

test('an older platform: ahead is advisory', async () => {
  reset();
  recordPlatformContract(header(CLI.version - 1, 'c'.repeat(64)), 'https://api.example.test/v1/me');
  const result = await runTypecheck(project());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('another origin and an unreadable record mean unknown, never current', async () => {
  reset();
  recordPlatformContract(header(CLI.version + 1, 'b'.repeat(64)), 'https://staging.example.test/v1/me');
  assert.equal(platformContractVerdict('https://api.example.test').status, 'unknown');
  writeFileSync(seenFile, '{not json');
  assert.equal(platformContractVerdict('https://api.example.test').status, 'unknown');
  assert.ok(existsSync(seenFile));
});

const warning = 'Warning: Your Somewhere CLI is behind the platform. Run npx -y @somewhere-cloud/cli@latest upgrade in this project.';
const cliPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const projectId = 'aaaaaaaa-1111-4222-8333-444444444444';

async function withCli(platformVersion, fn) {
  const home = mkdtempSync(join(tmpdir(), 'sw-contract-cli-'));
  const dir = mkdtempSync(join(tmpdir(), 'sw-contract-app-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>Fixture</title></head><body>Fixture</body></html>');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ token: 'smt_fixture', user: { email: 'dev@example.test', username: 'dev' } }));
  const server = createServer((req, res) => {
    res.setHeader('X-SW-Consumer-Contract', `${platformVersion}; digest=${'a'.repeat(64)}`);
    res.setHeader('Content-Type', 'application/json');
    req.resume();
    let data = {};
    if (req.url === '/v1/auth/whoami') data = { user: { email: 'dev@example.test', effective_tier: 'free' }, stats: { projects: 0, api_keys: 1 } };
    else if (req.url === '/v1/pricing') data = { tiers: [] };
    else if (req.url.startsWith('/v1/projects?')) data = { projects: [] };
    else if (req.url.startsWith('/v1/projects/')) data = { id: projectId, status: 'draft' };
    else if (req.url.startsWith('/v1/deploy/status')) data = { published: false };
    else if (req.url === '/v1/deploy') data = { version: 1, active_release_id: 'rel_fixture', release_id: 'rel_fixture', has_functions: false, url: 'https://fixture.example.test' };
    res.end(JSON.stringify({ ok: true, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn((args, debug) => new Promise((resolve) => {
      const env = {
        ...process.env, HOME: home, SOMEWHERE_CONFIG_DIR: home, SOMEWHERE_API_URL: `http://127.0.0.1:${server.address().port}/v1`,
        SOMEWHERE_NO_NOTIFICATIONS: '1', CI: '1', NO_COLOR: '1', NODE_DEBUG: debug ? 'somewhere-contract' : '',
      };
      const child = spawn(process.execPath, [cliPath, ...args], { cwd: dir, env });
      let stdout = '', stderr = '';
      child.stdout.on('data', (data) => stdout += data);
      child.stderr.on('data', (data) => stderr += data);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('CLI ahead: no contract line on deploy, whoami or cached lint; visible with debug', async () => {
  await withCli(CLI.version - 1, async (run) => {
    for (const args of [['whoami'], ['deploy', '--project', projectId], ['lint', '--json']]) {
      const result = await run(args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /consumer contract|behind the platform|last observed platform|"contract"/i);
    }
    const debug = await run(['whoami'], true);
    assert.match(debug.stderr, /Consumer contracts: CLI \d+, last observed platform \d+ \(ahead\)\./);
  });
});

test('CLI behind: an upgrade instruction once on deploy, none on whoami', async () => {
  await withCli(CLI.version + 1, async (run) => {
    const whoami = await run(['whoami']);
    assert.equal(whoami.status, 0, whoami.stdout + whoami.stderr);
    assert.doesNotMatch(whoami.stdout + whoami.stderr, /behind the platform|consumer contract/i);

    const deploy = await run(['deploy', '--project', projectId]);
    assert.equal(deploy.status, 0, deploy.stdout + deploy.stderr);
    assert.equal(deploy.stderr.split('\n').filter((line) => line === warning).length, 1);
    assert.doesNotMatch(deploy.stdout, /behind the platform/);

    const lint = await run(['lint']);
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    assert.equal(lint.stderr.split('\n').filter((line) => line === warning).length, 1);
  });
});
