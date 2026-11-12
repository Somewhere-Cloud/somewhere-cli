import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {scrub,safeError,rememberSecrets} from '../dist/lib/test-diagnostics.js';
import Reporter from '../dist/lib/test-reporter.js';
test('diagnostics omit reset URLs and rotated cookies',()=>{rememberSecrets('rotated-opaque-cookie');for(const value of ['https://app.somewhere.site/reset-password?token=reset-secret','https://app.somewhere.site/reset/reset-secret','rotated-opaque-cookie']){const output=JSON.stringify([scrub(value),safeError(value)]);assert.ok(!output.includes('reset-secret'));assert.ok(!output.includes('rotated-opaque-cookie'));}});
test('expected failures remain distinct and zero executed fails',async()=>{process.env.SW_TEST_RESULTS=join(mkdtempSync(join(process.env.TMPDIR,'report-')),'results.json');process.env.SW_TEST_JSON='true';const r=new Reporter();r.onBegin({}, {allTests:()=>[{},{}]});for(const status of ['passed','failed'])r.onTestEnd({title:'example',outcome:()=> 'expected'}, {status,attachments:[],steps:[]});assert.deepEqual(await r.onEnd({status:'passed',duration:1}),{status:'passed'});const report=JSON.parse(readFileSync(process.env.SW_TEST_RESULTS));assert.equal(report.failed,0);assert.equal(report.expectedFailures,1);assert.deepEqual(await new Reporter().onEnd({status:'passed',duration:1}),{status:'failed'});});
