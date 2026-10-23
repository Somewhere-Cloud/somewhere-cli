import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFFICIAL, validateTrigger, parseSelection, validateManifest, resolvePublished, assertAncestry, assertCheckout, testArguments } from '../scripts/advisory-ci.mjs';
const sha = 'a'.repeat(40);
const manifest = { name:'@somewhere-tech/cli', version:'1.2.3', gitHead:sha, repository:{ type:'git',url:`git+https://github.com/${OFFICIAL}.git` } };
const env = { GITHUB_REPOSITORY:OFFICIAL, GITHUB_REF:'refs/heads/master', GITHUB_EVENT_NAME:'schedule', GITHUB_SHA:sha };

test('schedule/manual only, official master, bounded explicit manual reason and selection', () => {
  validateTrigger(env);
  const manual = { ...env,GITHUB_EVENT_NAME:'workflow_dispatch',REGRESSION_REASON:'Investigate packet regression',REGRESSION_TESTS:'test/repro-packet.test.mjs' };
  validateTrigger(manual);
  for (const change of [{GITHUB_REPOSITORY:'fork/cli'},{GITHUB_REF:'refs/heads/feature'},{GITHUB_EVENT_NAME:'push'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_EVENT_NAME:'workflow_run'},{GITHUB_SHA:'oops'}]) assert.throws(()=>validateTrigger({...env,...change}));
  for (const reason of ['', ' ', 'x\nspoof', 'x'.repeat(501)]) assert.throws(()=>validateTrigger({...manual,REGRESSION_REASON:reason}));
  for (const value of ['', 'test/*.test.mjs', '../test/a.test.mjs', 'test/../../x.test.mjs','test/a.test.mjs;echo','$(id)','test/a.test.mjs test/a.test.mjs']) assert.throws(()=>parseSelection(value));
});
test('latest pin queried once; exact registry identity required and redirects disallowed', async () => {
  const calls=[];
  const pin=await resolvePublished(async(url,opts)=>{calls.push(url);assert.equal(opts.redirect,'error');return {ok:true,status:200,json:async()=>manifest};});
  assert.deepEqual(pin,{source:sha,version:'1.2.3'});
  assert.equal(calls.length,2);assert.equal(calls.filter(x=>x.endsWith('/latest')).length,1);assert.ok(calls[1].endsWith('/1.2.3'));
  let i=0;
  await assert.rejects(resolvePublished(async()=>({ok:true,status:200,json:async()=>++i===1?manifest:{...manifest,gitHead:'b'.repeat(40)}})),/disagrees/);
  await assert.rejects(resolvePublished(async()=>({ok:false,status:503})),/unavailable/);
  for(const bad of [{...manifest,name:'other'},{...manifest,version:'1.2.3\n'},{...manifest,gitHead:sha+'\n'}, {...manifest,repository:{type:'git',url:'git+https://github.com/evil/cli.git'}},{...manifest,repository:null}]) assert.throws(()=>validateManifest(bad));
});
function repo() {
  const p=mkdtempSync(join(tmpdir(),'cli-advisory-'));
  const git=(...a)=>execFileSync('git',a,{cwd:p,encoding:'utf8'}).trim();
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(p,'package.json'),JSON.stringify({name:'@somewhere-tech/cli',version:'1.2.3'}));git('add','.');git('commit','-qm','published');const first=git('rev-parse','HEAD');
  writeFileSync(join(p,'later'),'master advanced');git('add','.');git('commit','-qm','later');const next=git('rev-parse','HEAD');
  return {p,git,first,next};
}
test('real git: published ancestor remains valid after master advances; unrelated/off-master rejected',()=>{
  const {p,git,first,next}=repo();assertAncestry(first,next,p);assert.throws(()=>assertAncestry(next,first,p));
  git('checkout','-q',first);assertCheckout({source:first,version:'1.2.3'},p);
  assert.throws(()=>assertCheckout({source:next,version:'1.2.3'},p));assert.throws(()=>assertCheckout({source:first,version:'2.0.0'},p));
  git('checkout','--orphan','unrelated');writeFileSync(join(p,'other'),'x');git('add','.');git('commit','-qm','unrelated');assert.throws(()=>assertAncestry(git('rev-parse','HEAD'),next,p));
});
test('manual argv allowlist and actual native shard coverage preserve every file once',()=>{
  const p=mkdtempSync(join(tmpdir(),'cli-shards-'));mkdirSync(join(p,'test'));
  const roster=['test/a.test.mjs','test/b.test.mjs','test/c.test.mjs','test/d.test.mjs'];
  for(const [i,f] of roster.entries())writeFileSync(join(p,f),`import test from 'node:test';test('marker${i}',()=>{});`);
  const seen=[];
  for(const shard of ['1/2','2/2']) {
    const childEnv={...process.env}; delete childEnv.NODE_TEST_CONTEXT;
    const r=spawnSync(process.execPath,['--test-reporter=tap',...testArguments(shard,undefined,roster)],{cwd:p,encoding:'utf8',env:childEnv});assert.equal(r.status,0,r.stderr);
    seen.push(...[...r.stdout.matchAll(/# Subtest: marker(\d+)/g)].map(x=>x[1]));
  }
  assert.deepEqual(seen.sort(),['0','1','2','3']);
  assert.deepEqual(testArguments('manual','test/b.test.mjs',roster),['--test','--test-concurrency=1','test/b.test.mjs']);
  assert.throws(()=>testArguments('manual','test/absent.test.mjs',roster));assert.throws(()=>testArguments('3/2',undefined,roster));
});
test('workflow keeps schedule advisory, two serial isolated shards, manual one, no publisher dependency or credentials',()=>{
  const w=readFileSync(new URL('../.github/workflows/pr-gates.yml',import.meta.url),'utf8');
  assert.match(w,/cron: '37 \*\/3 \* \* \*'/);
  assert.doesNotMatch(w,/pull_request:|push:|workflow_run:|id-token:|secrets\.|npm publish|continue-on-error/);
  assert.match(w,/fail-fast: false/);assert.match(w,/max-parallel: 2/);assert.match(w,/persist-credentials: false/);
  assert.match(w,/ref: \$\{\{ needs.pin.outputs.source \}\}/);assert.match(w,/path: control/);assert.match(w,/path: published/);
  assert.doesNotMatch(w,/run:.*\$\{\{.*inputs/);
  assert.ok(w.indexOf('Verify published package')<w.indexOf('run: npm ci'));
  const publisher=readFileSync(new URL('../.github/workflows/publish.yml',import.meta.url),'utf8');
  assert.doesNotMatch(publisher,/advisory|npm test/);
  assert.match(publisher,/npm run build/);assert.match(publisher,/Verify published registry source, SRI and Sigstore/);
});
