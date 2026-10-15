import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

// What `somewhere login` tells the platform about this machine, so the
// approval page can show a device card the owner can recognise (tsk_d560943d).
test('describeThisDevice reports hostname, CLI version, runtime, platform and arch', async () => {
  const { describeThisDevice } = await import(join(repoRoot, 'dist', 'lib', 'device-login.js'));
  const meta = describeThisDevice();
  assert.equal(meta.cli_version, pkg.version, 'cli_version is the installed package version');
  assert.match(meta.runtime_version, /^node \d+\.\d+\.\d+/);
  assert.ok(meta.hostname.length > 0 && meta.hostname.length <= 64);
  assert.ok(!meta.hostname.endsWith('.local'));
  assert.ok(meta.platform.startsWith(process.platform));
  assert.equal(meta.arch, process.arch);
  for (const v of Object.values(meta)) assert.equal(typeof v, 'string');
});

test('a browser denial is reported as denial, not as a timeout', async () => {
  const { DeviceLoginDenied, DeviceLoginTimeout } = await import(join(repoRoot, 'dist', 'lib', 'device-login.js'));
  const denied = new DeviceLoginDenied();
  assert.match(denied.message, /denied in the browser/);
  assert.match(denied.message, /somewhere login/);
  assert.notEqual(denied.name, new DeviceLoginTimeout().name);
});

test('describeScope names all-projects and limited sessions plainly', async () => {
  const { describeScope } = await import(join(repoRoot, 'dist', 'commands', 'auth.js'));
  assert.equal(describeScope(null), 'all projects');
  assert.match(describeScope({ projects: ['11111111-1111-4111-8111-111111111111'] }), /^1 project only \(11111111\)/);
  assert.match(describeScope({ projects: ['a'.repeat(36), 'b'.repeat(36)] }), /^2 projects only/);
});

// Real CLI transport, synthetic loopback server; no platform account or key mint.
test('device login binds private verifier without URL/output exposure and never retries uncertain delivery', async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { createHash } = await import('node:crypto');
  let mode = 'success', registered, polls = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    res.setHeader('content-type','application/json');
    if (req.url === '/v1/auth/device-code') {
      registered = body;
      res.end(JSON.stringify({ok:true,data:{approval_url:'https://fixture.invalid/auth?code='+body.code,verifier_bound:mode !== 'old'}}));
    } else {
      polls.push({url:req.url,method:req.method,body});
      res.statusCode = mode === 'unknown' ? 503 : 200;
      res.end(JSON.stringify(mode === 'unknown' ? {ok:false,error:'DEVICE_CODE_REDEMPTION_UNAVAILABLE'} : {ok:true,data:{status:'approved',token:'smt_fixture',email:'fixture@example.invalid',refresh_token:'fixture-refresh'}}));
    }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const script = `const {deviceLogin}=await import(${JSON.stringify(join(repoRoot,'dist/lib/device-login.js'))});try{const r=await deviceLogin({onPrompt:x=>console.log(JSON.stringify(x))});console.log(r.config.token);}catch(e){console.log(e.message);process.exitCode=1;}`;
  const run = () => promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,SOMEWHERE_API_URL:'http://127.0.0.1:'+server.address().port+'/v1',NO_PROXY:'127.0.0.1'},timeout:15000});
  try {
    const result = await run(); assert.equal(polls.length,1); const poll=polls[0];
    assert.equal(poll.method,'POST');assert.equal(poll.url,'/v1/auth/device-code/status');
    assert.match(poll.body.verifier,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(createHash('sha256').update(poll.body.verifier).digest('hex'),registered.code_challenge);
    assert.equal(result.stdout.includes(poll.body.verifier),false);assert.equal(result.stderr.includes(poll.body.verifier),false);
    mode='old';polls=[];await assert.rejects(run(),e=>/does not support secure device redemption/.test(e.stdout));assert.equal(polls.length,0);
    mode='unknown';polls=[];await assert.rejects(run(),e=>/will not be retried/.test(e.stdout));assert.equal(polls.length,1);
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
});
