import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {scrub,describeError,rememberSecrets} from '../dist/lib/test-diagnostics.js';
import Reporter from '../dist/lib/test-reporter.js';
test('diagnostics omit reset URLs and rotated cookies',()=>{rememberSecrets('rotated-opaque-cookie');for(const value of ['https://app.somewhere.site/reset-password?token=reset-secret','https://app.somewhere.site/reset/reset-secret','rotated-opaque-cookie']){const output=JSON.stringify([scrub(value),describeError({message:value})]);assert.ok(!output.includes('reset-secret'));assert.ok(!output.includes('rotated-opaque-cookie'));}});
test('expected failures remain distinct and zero executed fails',async()=>{process.env.SW_TEST_RESULTS=join(mkdtempSync(join(process.env.TMPDIR,'report-')),'results.json');process.env.SW_TEST_JSON='true';const r=new Reporter();r.onBegin({}, {allTests:()=>[{},{}]});for(const status of ['passed','failed'])r.onTestEnd({id:'t-'+status,title:'example',location:{file:join(process.cwd(),'tests/a.spec.ts'),line:3},outcome:()=> 'expected'}, {status,attachments:[],steps:[],errors:[]});assert.deepEqual(await r.onEnd({status:'passed',duration:1}),{status:'passed'});const report=JSON.parse(readFileSync(process.env.SW_TEST_RESULTS));assert.equal(report.failed,0);assert.equal(report.expectedFailures,1);assert.deepEqual(await new Reporter().onEnd({status:'passed',duration:1}),{status:'failed'});});

test('a failing test reports the scrubbed assertion with its file and line, in text and JSON',async()=>{
 const root=process.cwd();process.env.SW_TEST_RESULTS=join(mkdtempSync(join(process.env.TMPDIR,'report-')),'results.json');process.env.SW_TEST_JSON='true';
 const r=new Reporter();r.onBegin({}, {allTests:()=>[{}]});
 const body=Buffer.from(JSON.stringify({title:'refusal',errors:['Error: Expected HTTP 403 MEMBERSHIP_REQUIRED; received HTTP 403 POLICY_AUTHORITY_REQUIRED'],timings:{}}));
 r.onTestEnd({id:'t1',title:'refusal',location:{file:join(root,'tests/team.spec.ts'),line:40},outcome:()=>'unexpected'},{status:'failed',attachments:[{name:'somewhere-diagnostics',body}],steps:[],errors:[{message:'raw',location:{file:join(root,'tests/team.spec.ts'),line:42,column:3}}]});
 await r.onEnd({status:'failed',duration:1});
 const report=JSON.parse(readFileSync(process.env.SW_TEST_RESULTS));
 assert.deepEqual(report.tests[0].errors,['tests/team.spec.ts:42: Error: Expected HTTP 403 MEMBERSHIP_REQUIRED; received HTTP 403 POLICY_AUTHORITY_REQUIRED']);
});
test('collection errors print their real reason',()=>{
 const lines=[];const original=console.error;console.error=(line)=>lines.push(line);
 try{const r=new Reporter();r.onError({message:'Error: No tests found.\nMake sure that arguments are regular expressions matching test files.'});}finally{console.error=original;}
 assert.match(lines[0],/^Setup error: collection: Error: No tests found\./);
});
