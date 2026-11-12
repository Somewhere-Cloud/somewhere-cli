// The CLI knows when it is out of date (tsk_0f3d05b9): its vendored platform bundle carries the
// consumer contract it implements; every platform response announces the platform's; typecheck
// and lint refuse to claim a clean result when the two are known to differ, and say "unknown"
// when nothing has been recorded. Offline: a loopback server stands in for the platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
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
