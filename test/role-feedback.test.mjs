import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {roleMethodHints} from '../dist/lib/role-method-hints.js';
import {formatErrorDetail} from '../dist/commands/errors.js';
import {describeFunctionRefusal} from '../dist/commands/logs.js';
import {ROLE_CHANGE_METHOD_MESSAGE} from '../dist/lib/runtime-refusals.js';

test('known role refusals show the fixed fix while unrelated/body text stays unchanged',()=>{
 assert.match(formatErrorDetail('ROLE_CHANGE_METHOD_NOT_ALLOWED','ROLE_CHANGE_METHOD_NOT_ALLOWED'),/POST setup handler/);
 const log={source:'function',level:'warn',message:'GET /api/me → 405',created_at:'2026-11-13',data:{error:'ROLE_CHANGE_METHOD_NOT_ALLOWED'}};
 assert.match(describeFunctionRefusal(log).message,/POST setup handler/);
 assert.equal(describeFunctionRefusal({...log,source:'client'}).message,log.message);
 assert.equal(describeFunctionRefusal({...log,data:{error:'METHOD_NOT_ALLOWED',message:'private-body'}}).message,log.message);
 if(process.env.SOMEWHERE_PLATFORM_REPO)assert.ok(readFileSync(join(process.env.SOMEWHERE_PLATFORM_REPO,'worker/src/runtime/auth-server.ts'),'utf8').includes(ROLE_CHANGE_METHOD_MESSAGE));
});
test('GET-only role hint parses exports/calls, ignoring comments, defaults and POST routes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'role-method-hints-'));mkdirSync(join(dir,'api'));
 try{
  const examples={
   'get.ts':`export const GET = sw.endpoint({handler: async (_, sw) => sw.auth.server.setRoles('u',{add:['staff']})});`,
   'alias.ts':`const handler = (_, sw) => sw.auth.server.grantRole('u','staff'); export {handler as GET};`,
   'post.ts':`export default (_, sw) => sw.auth.server.setRoles('u',{add:['staff']});`,
   'mixed.ts':`export const GET=(_,sw)=>sw.auth.server.revokeRole('u','staff');export const POST=()=>({});`,
   'comment.ts':`// sw.auth.server.setRoles('u',{})\nexport const GET=()=>({});`,
  };
  for(const [file,source] of Object.entries(examples))writeFileSync(join(dir,'api',file),source);
  const hints=roleMethodHints(dir);assert.equal(hints.length,2);assert.ok(hints.every(x=>x.includes('POST setup handler')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
