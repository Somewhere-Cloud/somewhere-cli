import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli=fileURLToPath(new URL('../bin/somewhere.js',import.meta.url));
const previous={version:1,rollback_available:true,message:'Version 1 is kept; somewhere rollback returns to it.'};
const result={project_id:'11111111-1111-4111-8111-111111111111',version:2,release_id:'r2',active_release_id:'r2',files_deployed:1,has_functions:false,url:'https://fixture.somewhere.site',previous};
const server=createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,data:req.method==='POST'&&req.url.startsWith('/v1/deploy')?result:{}}));});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));test.after(()=>server.close());
async function run(json, npmCommand){const base=mkdtempSync(join(tmpdir(),'sw-previous-')),app=join(base,'app'),config=join(base,'config');mkdirSync(app);mkdirSync(config);writeFileSync(join(config,'config.json'),JSON.stringify({token:'smt_fixture',user:{email:'fixture@example.test',username:'fixture'}}));writeFileSync(join(app,'.somewhere.json'),JSON.stringify({project_id:result.project_id,base_release_id:'r1',subdomain:'fixture'}));writeFileSync(join(app,'index.html'),'<html><body>Hello</body></html>');return new Promise(resolve=>{const child=spawn(process.execPath,[cli,'deploy','--force','--yes',...(json?['--json']:[])],{cwd:app,env:{...process.env,npm_command:npmCommand ?? "",SOMEWHERE_CONFIG_DIR:config,SOMEWHERE_API_URL:`http://127.0.0.1:${server.address().port}/v1`,SOMEWHERE_NO_NOTIFICATIONS:'1',CI:'1',NO_COLOR:'1'}});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('close',status=>resolve({status,stdout,stderr}));});}
test('human deploy prints predecessor and JSON preserves structured field',async()=>{const human=await run(false);assert.equal(human.status,0,human.stderr);assert.match(human.stdout, /Version 1 is kept; somewhere rollback --yes returns to it\./);const npx=await run(false,"exec");assert.equal(npx.status,0,npx.stderr);assert.match(npx.stdout, /Version 1 is kept; npx -y @somewhere-cloud\/cli@latest rollback --yes returns to it\./);const json=await run(true);assert.equal(json.status,0,json.stderr);assert.deepEqual(JSON.parse(json.stdout).previous,previous);});
