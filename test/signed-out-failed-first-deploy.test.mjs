// tsk_b9900dbb: a failed first anonymous deploy must not strand the folder, an
// unreadable sign-in file is said out loud, and a network failure names its host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { linkNeverDeployed, formatSignedOutExistingTargetExplanation } from '../dist/commands/deploy.js';
import { describeNetworkFailure } from '../dist/lib/http.js';

const BIN = fileURLToPath(new URL('../bin/somewhere.js', import.meta.url));
const scratch = () => mkdtempSync(join(process.env.TMPDIR || '.', 'b9900-'));

test('a link whose first deploy never went live is recognised; a deployed one is not', () => {
  const id = 'abcc713f-d5f8-4f93-a085-239a54cd418b';
  assert.equal(linkNeverDeployed({ project_id: id, source_base: { project_id: id, release_id: null, at: 'x' } }), true);
  assert.equal(linkNeverDeployed({ project_id: id, source_base: { project_id: id, release_id: 'rel_1', at: 'x' } }), false);
  assert.equal(linkNeverDeployed({ project_id: id }), false, 'an old link without a recorded base is kept');
  assert.equal(linkNeverDeployed({ project_id: id, source_base: { project_id: id, release_id: null, at: 'x' },
    last_deploy: { project_id: id, last_deployed_version: 1, at: 'x' } }), false);
});

test('signed out with a deployed link: the refusal says where the temporary credential lives', () => {
  const text = formatSignedOutExistingTargetExplanation('p1', true);
  assert.match(text, /run `somewhere deploy` there/);
  assert.match(text, /sandboxed shell/);
  assert.match(text, /somewhere auth set/);
});

test('signed out, never-deployed link, no credential: deploy does not refuse on the link', () => {
  const home = scratch();
  const app = scratch();
  writeFileSync(join(app, '.somewhere.json'), JSON.stringify({ project_id: 'abcc713f-d5f8-4f93-a085-239a54cd418b',
    source_base: { project_id: 'abcc713f-d5f8-4f93-a085-239a54cd418b', release_id: null, at: 'x' } }));
  writeFileSync(join(app, 'index.html'), '<h1>x</h1>');
  // A dead API host: the deploy gets past the link check and fails on the network, naming the host.
  const r = spawnSync(process.execPath, [BIN, 'deploy'], { cwd: app, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: home, SOMEWHERE_CONFIG_DIR: '', SOMEWHERE_API_URL: 'http://127.0.0.1:9/v1' } });
  const out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /cannot deploy to an existing project/);
  assert.match(out, /Could not reach .*127\.0\.0\.1:9/);
  assert.match(out, /add 127\.0\.0\.1:9, or run the command in your own terminal/);
});

test('an unreadable sign-in file stops the command and names the file', { skip: process.getuid?.() === 0 }, () => {
  const home = scratch();
  mkdirSync(join(home, '.somewhere'));
  writeFileSync(join(home, '.somewhere', 'config.json'), '{}');
  chmodSync(join(home, '.somewhere', 'config.json'), 0o000);
  const r = spawnSync(process.execPath, [BIN, 'claim'], { encoding: 'utf8', env: { ...process.env, HOME: home, SOMEWHERE_CONFIG_DIR: '' } });
  chmodSync(join(home, '.somewhere', 'config.json'), 0o600);
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /cannot read .*config\.json \(EACCES\)/);
});

test('a bare "fetch failed" becomes a message with the host and a next step', () => {
  const raw = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.somewhere.cloud'), { code: 'ENOTFOUND' }) });
  const out = describeNetworkFailure(raw, 'https://api.somewhere.cloud/v1/auth/device-code');
  assert.match(out.message, /^Could not reach api\.somewhere\.cloud \(ENOTFOUND/);
  assert.match(out.message, /add api\.somewhere\.cloud, or run the command in your own terminal/);
  assert.equal(out.cause.code, 'ENOTFOUND');
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  assert.equal(describeNetworkFailure(timeout, 'https://x'), timeout);
});
